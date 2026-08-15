import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { githubRequest, githubToken, parseRepoSlug, type RepoSlug } from "@/lib/github";
import { getSetting } from "@/lib/settings";
import { DEFAULT_POLL_INTERVAL, POLL_INTERVAL_SETTING } from "@/lib/polling";
import { enqueueDeploy } from "./deploy-queue";

/**
 * Auto-deploy by asking, for the panels nothing can reach.
 *
 * The webhook path assumes GitHub can open a connection to this machine. A
 * self-hosted panel very often lives where that is false — behind NAT with no
 * port forwarded, on a Tailscale or WireGuard network, on a laptop — and there
 * the failure is total and silent: the delivery never arrives, so there is
 * nothing in any log here to find. No configuration fixes it, because the
 * problem is the direction of the connection.
 *
 * Turning it around costs one outbound request per project per tick and works
 * from anywhere with an internet connection. It is slower than a webhook by up
 * to one interval, which is the whole price.
 *
 * Modelled on `startBackupScheduler()`: the same `globalThis` guard so a
 * dev-mode reload does not leave two timers, the same `.unref()` so a
 * background chore never holds the process open, and the same rule that a tick
 * which throws must not kill the interval.
 */

/**
 * Fifteen seconds, to serve a thirty-second interval honestly.
 *
 * The tick does not decide when a project is checked — `poll_checked_at` does.
 * What the tick sets is the granularity, and a period equal to the shortest
 * interval would round it to somewhere between one and two intervals. A tick
 * that finds nothing due is one indexed SELECT that usually returns no rows.
 */
const TICK_MS = 15_000;
/** Long enough after boot for the store to be ready. */
const FIRST_TICK_DELAY_MS = 20_000;
const DEFAULT_INTERVAL_SECONDS = Number(DEFAULT_POLL_INTERVAL);

const globalRef = globalThis as typeof globalThis & {
  __runpanelPollTimer?: NodeJS.Timeout;
  __runpanelPollFirstTick?: NodeJS.Timeout;
};

/**
 * ETags, kept in memory on purpose.
 *
 * GitHub does not count a 304 against the hourly rate limit, so a branch that
 * has not moved is free to check. Losing the map on restart costs one full
 * response per project and nothing else, which is not worth a column.
 */
const etags = new Map<string, string>();

export function startDeployPoller(): void {
  if (globalRef.__runpanelPollTimer) return;

  globalRef.__runpanelPollTimer = setInterval(() => void pollTick(), TICK_MS);
  globalRef.__runpanelPollTimer.unref?.();

  globalRef.__runpanelPollFirstTick = setTimeout(() => void pollTick(), FIRST_TICK_DELAY_MS);
  globalRef.__runpanelPollFirstTick.unref?.();
}

export async function pollIntervalSeconds(): Promise<number> {
  const raw = await getSetting(POLL_INTERVAL_SETTING);
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_SECONDS;
}

/** "30 secondi", "5 minuti" — written once so the checks and the form agree. */
export function pollIntervalLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} secondi`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minut${minutes === 1 ? "o" : "i"}`;
}

export interface PollTickResult {
  considered: number;
  checked: number;
  deployed: number;
  failed: number;
}

/** Every project that has asked to be polled. */
async function pollableProjects(): Promise<ProjectsTable[]> {
  const db = await getDb();
  return db
    .selectFrom("projects")
    .selectAll()
    .where("auto_deploy", "=", 1)
    .where("source_type", "=", "github")
    .where("deploy_trigger", "=", "poll")
    .execute();
}

function isDue(project: ProjectsTable, now: Date, intervalMs: number): boolean {
  if (!project.poll_checked_at) return true;
  const last = Date.parse(project.poll_checked_at);
  if (!Number.isFinite(last)) return true;

  /*
    Half a tick of slack.

    Ticks do not land on the interval, so a check due at exactly 30s is seen at
    30-and-a-bit and the one after at 60-and-a-bit — every interval quietly
    becomes one tick longer than the operator asked for. Allowing it to fire
    slightly early keeps the average on the number in the settings.
  */
  return now.getTime() - last >= intervalMs - TICK_MS / 2;
}

/** Exported so a test can drive a tick without waiting a minute for one. */
export async function pollTick(now = new Date()): Promise<PollTickResult> {
  const result: PollTickResult = { considered: 0, checked: 0, deployed: 0, failed: 0 };

  try {
    const projects = await pollableProjects();
    if (projects.length === 0) return result;

    const token = await githubToken();
    if (!token) {
      // Nothing to be done about it here, and saying so every minute would bury
      // the log. The settings tab reports it where someone can act on it.
      return result;
    }

    const intervalMs = (await pollIntervalSeconds()) * 1000;

    for (const project of projects) {
      result.considered++;
      if (!isDue(project, now, intervalMs)) continue;

      const outcome = await checkProject(project, token, now);
      if (outcome === "failed") result.failed++;
      else {
        result.checked++;
        if (outcome === "deployed") result.deployed++;
      }
    }
  } catch (err) {
    // A tick that throws must not kill the interval, or the panel silently
    // stops deploying until someone restarts it.
    console.error("[poll] Tick fallito:", err);
  }

  return result;
}

type Outcome = "unchanged" | "deployed" | "failed";

/**
 * The commit a branch points at.
 *
 * `git/ref/heads/<branch>` rather than the commits list: it answers with the
 * SHA alone, it is exact about which ref was asked for, and branch names
 * containing a slash work without special handling.
 */
async function headSha(
  slug: RepoSlug,
  branch: string,
  token: string,
  cacheKey: string
): Promise<{ sha: string | null; unchanged: boolean } | null> {
  const path = `/repos/${slug.full}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const known = etags.get(cacheKey);

  let res: Response;
  try {
    res = await githubRequest(path, token, {
      headers: known ? { "If-None-Match": known } : undefined,
    });
  } catch {
    return null;
  }

  // Not modified: the branch is where it was, and this one was free.
  if (res.status === 304) return { sha: null, unchanged: true };

  if (!res.ok) {
    if (res.status === 404) {
      console.warn(`[poll] ${slug.full}: branch ${branch} non trovato`);
    } else if (res.status === 403 || res.status === 429) {
      console.warn(`[poll] ${slug.full}: limite di richieste GitHub raggiunto`);
    } else {
      console.warn(`[poll] ${slug.full}: GitHub ha risposto ${res.status}`);
    }
    return null;
  }

  const etag = res.headers.get("etag");
  if (etag) etags.set(cacheKey, etag);

  const body = (await res.json()) as { object?: { sha?: string } };
  const sha = body.object?.sha ?? null;
  return sha ? { sha, unchanged: false } : null;
}

async function checkProject(
  project: ProjectsTable,
  token: string,
  now: Date
): Promise<Outcome> {
  const slug = parseRepoSlug(project.source_url);
  if (!slug) return "failed";

  const head = await headSha(slug, project.source_branch, token, project.id);
  if (!head) return "failed";

  const db = await getDb();
  const checkedAt = now.toISOString();

  if (head.unchanged || head.sha === project.poll_sha) {
    await db
      .updateTable("projects")
      .set({ poll_checked_at: checkedAt })
      .where("id", "=", project.id)
      .execute();
    return "unchanged";
  }

  /*
    The first look records and does not deploy.

    Someone switching a project to polling has said "deploy what comes next",
    not "deploy whatever is on the branch right now" — and the two differ
    exactly when the repository has moved on since the last manual deploy, which
    is when an unrequested build would be most surprising. The backup scheduler
    takes the same line with a policy that has never run.
  */
  const first = project.poll_sha === null;

  // Written before the deploy is queued, and deliberately: a commit that fails
  // to build must not be retried every interval forever. One attempt per
  // commit, exactly as a webhook delivers one push once.
  await db
    .updateTable("projects")
    .set({ poll_sha: head.sha, poll_checked_at: checkedAt, updated_at: nowIso() })
    .where("id", "=", project.id)
    .execute();

  if (first) return "unchanged";

  const short = head.sha!.slice(0, 7);
  console.log(`[poll] ${project.slug}: nuovo commit ${short} su ${project.source_branch}`);

  await enqueueDeploy(project.id, {
    mode: "deploy",
    trigger: "poll",
    commitSha: head.sha,
    commitMessage: null,
  });

  return "deployed";
}

/**
 * Record where the branch is now, without deploying it.
 *
 * Called when a project switches to polling, so the first tick has a baseline
 * and does not read "no SHA recorded" as "everything is new".
 */
export async function primePollBaseline(project: ProjectsTable): Promise<void> {
  const slug = parseRepoSlug(project.source_url);
  if (!slug) return;

  const token = await githubToken();
  if (!token) return;

  const head = await headSha(slug, project.source_branch, token, project.id);
  if (!head?.sha) return;

  const db = await getDb();
  await db
    .updateTable("projects")
    .set({ poll_sha: head.sha, poll_checked_at: new Date().toISOString() })
    .where("id", "=", project.id)
    .execute();
}
