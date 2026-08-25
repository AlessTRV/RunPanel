/**
 * The shape of `GET /api/updates`, as the browser sees it.
 *
 * Types only, and in `lib/` rather than beside either consumer, because there
 * are two of them and they live in different trees: the banner is mounted in
 * the panel shell (`components/`) and the page is a route (`app/(panel)/`).
 * Declaring it twice is how the two would eventually disagree about what
 * `phase` can be.
 */

export type UpdatePhase =
  | "running"
  | "awaiting-restart"
  | "awaiting-manual"
  | "done"
  | "failed";

export type RestartMethod = "systemd" | "cron" | "container" | "manual";

export interface UpdateCommit {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface UpdateCheck {
  checkedAt: string;
  branch: string | null;
  remote: string | null;
  localSha: string | null;
  remoteSha: string | null;
  behind: number;
  commits: UpdateCommit[];
  error: string | null;
}

export interface UpdateRun {
  runId: string;
  phase: UpdatePhase;
  step: string | null;
  branch: string | null;
  fromSha: string | null;
  toSha: string | null;
  packageManager: string | null;
  startedAt: string;
  finishedAt: string | null;
  bootedAt: string | null;
  error: string | null;
  storeBackup: string | null;
  distBackup: string | null;
  manualCommands: string[];
}

export interface PanelRelease {
  version: string;
  /** Commits on the mainline, or null when git could not count them. */
  number: number | null;
  sha: string | null;
  short: string | null;
  date: string | null;
  shallow: boolean;
  /** `v0.1.0+142`, already assembled. */
  label: string;
}

export interface UpdateStatus {
  version: string;
  release: PanelRelease;
  checkout: {
    isRepo: boolean;
    branch: string | null;
    detached: boolean;
    head: string | null;
    short: string | null;
    remote: string | null;
  };
  check: UpdateCheck | null;
  run: UpdateRun | null;
  /** The id of a run happening right now, or null. */
  busy: string | null;
  canUpdate: { ok: boolean; reason: string | null; restart: RestartMethod };
  /** Something else is running that an update would interrupt. */
  blocker: { reason: string } | null;
  interval: string;
}

/** Whether the panel is mid-update, for the two screens that dim their buttons. */
export function isUpdateActive(status: UpdateStatus | null): boolean {
  if (!status) return false;
  if (status.busy) return true;
  const phase = status.run?.phase;
  return phase === "running" || phase === "awaiting-restart";
}

/**
 * Whether there is something to install, as opposed to something to read.
 *
 * The last clause is the one that is easy to leave out. A check records the
 * commit it was taken against, and the panel can move underneath it — somebody
 * updates by hand over SSH, or restores an older checkout. Without comparing
 * the two, a stale row keeps a banner on screen offering commits that are
 * already installed, and it stays there until the next scheduled check.
 */
export function hasUpdate(status: UpdateStatus | null): boolean {
  if (!status?.check || status.check.error) return false;
  if (status.check.behind <= 0) return false;
  return status.check.localSha === status.checkout.head;
}

/**
 * Whether an update must carry a signature the host can verify.
 *
 * Off by default, and deliberately so: a panel whose operator does not sign
 * commits would otherwise stop being able to update itself the moment this
 * shipped. Stored as `"0"` / `"1"` like every other preference in the settings
 * table.
 */
export const PANEL_UPDATE_REQUIRE_SIGNATURE_SETTING = "panel_update_require_signature";

/**
 * The SSH allowed-signers file, verbatim.
 *
 * Public keys, so not a secret — but written to disk 0600 anyway, because the
 * file *is* the trust root once signature verification is on, and a file
 * anybody can append to is not a trust root.
 */
export const PANEL_UPDATE_ALLOWED_SIGNERS_SETTING = "panel_update_allowed_signers";
