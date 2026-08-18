import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The words that end up on somebody's phone, checked without a bot.
 *
 * Two things here are worth a test rather than a read-through. The escaping,
 * because none of the text in a notification is written by the panel — commit
 * subjects, error messages and project names all arrive from outside, and a
 * single unescaped `<` does not degrade the formatting, it makes Telegram
 * reject the whole message with `can't parse entities`. And the hysteresis on
 * the disk watch, because a threshold without one alternates between warning
 * and all-clear for as long as the disk sits on the boundary.
 */
export const meta = { name: "notify-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("notify-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

  const {
    escapeHtml,
    firstLine,
    duration,
    bytes,
    clamp,
    render,
    describe,
    shouldAnnounceDeploy,
    diskLow,
    MAX_MESSAGE_LENGTH,
  } = await load("services", "notify", "messages.ts");
  const { parseNotifyEvents, DEFAULT_NOTIFY_EVENTS, NOTIFY_GROUPS, NOTIFY_EVENTS } = await load(
    "lib", "notify-events.ts"
  );

  // --- Escaping -------------------------------------------------------------
  r.check("angle brackets are escaped", escapeHtml("a <b> c") === "a &lt;b&gt; c", escapeHtml("a <b> c"));
  r.check("ampersands go first", escapeHtml("&lt;") === "&amp;lt;", escapeHtml("&lt;"));
  r.check(
    "apostrophes are left alone",
    escapeHtml("l'aggiornamento") === "l'aggiornamento",
    "escaping them would make every Italian sentence unreadable"
  );
  r.check("emoji survive", escapeHtml("🚚 ok") === "🚚 ok");

  // The subject of a real commit in this repository.
  const subject = "projects: 🚚 Added moving a native project's checkout to another disk";
  r.check("a real commit subject is unchanged", escapeHtml(subject) === subject);

  // --- Nothing reaches Telegram unescaped ----------------------------------
  //
  // The important assertion in this file: build an event out of the nastiest
  // strings a project can produce and check none of it lands raw.
  const nasty = '<script>alert("x")</script> & <b>';
  const message = describe({
    key: "deploy.finished",
    slug: nasty,
    ok: false,
    trigger: "webhook",
    commitSha: "4d480c77bd43af994d435e8437f9b4870a276172",
    commitMessage: nasty,
    durationMs: 91_000,
    error: nasty,
  });
  const rendered = render(message);

  r.check("no raw <script> survives", !rendered.includes("<script>"), rendered.slice(0, 120));
  r.check("the payload is escaped", rendered.includes("&lt;script&gt;"), rendered.slice(0, 200));
  r.check(
    "only the tags we generate remain",
    (rendered.match(/<(?!\/?(b|code|a)\b)[a-zA-Z]/g) ?? []).length === 0,
    rendered
  );

  // --- Deploy wording -------------------------------------------------------
  const okDeploy = describe({
    key: "deploy.finished",
    slug: "spanel",
    ok: true,
    trigger: "poll",
    commitSha: "4d480c77bd43af994d435e8437f9b4870a276172",
    commitMessage: subject,
    durationMs: 91_000,
    error: null,
  });
  r.check("a successful deploy reads as success", okDeploy.level === "ok", okDeploy.level);
  r.check("it names the project", okDeploy.title.includes("spanel"), okDeploy.title);
  r.check("it shortens the sha", okDeploy.body.includes("4d480c7"), okDeploy.body);
  r.check("it does not print the full sha", !okDeploy.body.includes("4d480c77bd"), okDeploy.body);
  r.check("it says how the deploy was triggered", okDeploy.body.includes("controllo periodico"));
  r.check("it renders the duration in minutes", okDeploy.body.includes("1 m 31 s"), okDeploy.body);
  r.check("a failed deploy reads as danger", message.level === "danger", message.level);

  // --- Which deploys are announced -----------------------------------------
  r.check("an automatic deploy that worked is news", shouldAnnounceDeploy("webhook", true) === true);
  r.check("so is one from the periodic check", shouldAnnounceDeploy("poll", true) === true);
  r.check("a manual deploy that worked is not", shouldAnnounceDeploy("manual", true) === false);
  r.check("a manual deploy that failed is", shouldAnnounceDeploy("manual", false) === true);
  r.check("and so is an automatic failure", shouldAnnounceDeploy("poll", false) === true);

  // --- Backups: every outcome, including the good one ----------------------
  const backup = (status, extra = {}) =>
    describe({
      key: "backup.finished",
      policy: "Notturno",
      status,
      ok: 3,
      failed: 0,
      skipped: 1,
      bytes: 1024 * 1024 * 512,
      durationMs: 45_000,
      error: null,
      ...extra,
    });

  r.check("a successful backup is announced", backup("success").level === "ok");
  r.check("and says how much it wrote", backup("success").body.includes("512 MB"), backup("success").body);
  r.check("a partial backup warns", backup("partial").level === "warn");
  r.check("a failed backup is danger", backup("failed").level === "danger");
  r.check("the policy name is carried", backup("success").body.includes("Notturno"));

  // --- The rest of the catalogue -------------------------------------------
  r.check(
    "a crashed project says it was not the panel",
    describe({ key: "project.crashed", slug: "api", runtime: "node" }).body.includes("non è stato il pannello"),
  );
  r.check("docker coming back is good news", describe({ key: "docker.down", up: true }).level === "ok");
  r.check("docker going away is not", describe({ key: "docker.down", up: false }).level === "danger");

  const low = describe({
    key: "disk.low",
    up: false,
    freeBytes: 5 * 1024 ** 3,
    totalBytes: 100 * 1024 ** 3,
    path: "/srv/runpanel/data",
  });
  r.check("a low disk warns", low.level === "warn", low.level);
  r.check("and gives the percentage", low.body.includes("5%"), low.body);

  const update = describe({ key: "panel.update", behind: 1, from: "a".repeat(40), to: "b".repeat(40), branch: "main" });
  r.check("one commit is singular", update.body.includes("1 commit nuovo"), update.body);

  const restarted = describe({ key: "panel.restarted", version: "0.1.0", sha: "c".repeat(40), afterUpdate: true });
  r.check("a restart after an update reads as success", restarted.level === "ok");
  r.check(
    "a restart nobody asked for hints at a crash",
    describe({ key: "panel.restarted", version: "0.1.0", sha: null, afterUpdate: false }).body.includes("è caduto"),
  );

  // Every key in the catalogue has to produce something, or a switch the
  // operator turned on would silently do nothing.
  for (const key of NOTIFY_EVENTS) {
    const covered = NOTIFY_GROUPS.some((group) => group.events.some((event) => event.key === key));
    r.check(`${key} appears in a group the UI draws`, covered);
  }

  // --- Formatting helpers ---------------------------------------------------
  r.check("seconds stay seconds", duration(45_000) === "45 s", duration(45_000));
  r.check("minutes are split out", duration(91_000) === "1 m 31 s", duration(91_000));
  r.check("an unknown duration is omitted", duration(null) === null);
  r.check("bytes scale", bytes(1536) === "1.5 KB", bytes(1536));
  r.check("and stay whole when large", bytes(1024 ** 3 * 5) === "5.0 GB" || bytes(1024 ** 3 * 5) === "5 GB", bytes(1024 ** 3 * 5));

  const long = "x".repeat(MAX_MESSAGE_LENGTH + 500);
  r.check("an oversized message is clamped", clamp(long).length <= MAX_MESSAGE_LENGTH, String(clamp(long).length));
  r.check("a short one is untouched", clamp("hello") === "hello");

  r.check("ANSI colour is stripped", firstLine("[31mERRORE[0m: qualcosa") === "ERRORE: qualcosa",
    firstLine("[31mERRORE[0m: qualcosa"));
  r.check("only the first non-empty line is kept",
    firstLine("\n\nprimo\nsecondo") === "primo", firstLine("\n\nprimo\nsecondo"));

  // --- Disk hysteresis ------------------------------------------------------
  //
  // A disk sitting exactly on the threshold is precisely what a disk that is
  // filling up does, and without the gap it would alternate forever.
  r.check("9% free trips the warning", diskLow(9, 100, false) === true);
  r.check("11% free does not", diskLow(11, 100, false) === false);
  r.check("once warned, 11% stays warned", diskLow(11, 100, true) === true);
  r.check("13% clears it", diskLow(13, 100, true) === false);
  r.check("an empty disk is not a division by zero", diskLow(0, 0, false) === false);

  // --- Stored selection -----------------------------------------------------
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  r.check("no stored value means the defaults", same(parseNotifyEvents(null), DEFAULT_NOTIFY_EVENTS));
  r.check(
    "and a copy of them, not the array itself",
    parseNotifyEvents(null) !== DEFAULT_NOTIFY_EVENTS,
    "a caller that sorted it would change the defaults for the whole process"
  );
  r.check("a stored list is kept", parseNotifyEvents('["deploy.finished"]').length === 1);
  r.check("an empty list is respected, not replaced",
    parseNotifyEvents("[]").length === 0, "turning everything off must be possible");
  r.check("an unknown key is dropped",
    parseNotifyEvents('["deploy.finished","nope"]').length === 1);
  r.check("garbage falls back to the defaults", same(parseNotifyEvents("{oops"), DEFAULT_NOTIFY_EVENTS));
  r.check("every default is a real key",
    DEFAULT_NOTIFY_EVENTS.every((key) => NOTIFY_EVENTS.includes(key)));

  return r.result();
}
