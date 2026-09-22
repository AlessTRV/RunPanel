import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * What a scheduled restart does when its moment comes.
 *
 * The rule the operator asked for, stated once: a running target is restarted;
 * one that was stopped on purpose is left alone; one that went down by itself
 * gets exactly one attempt, and if that fails it is left alone until it comes
 * back or crashes again. Pure data in, data out, so the whole matrix runs
 * without a daemon or a clock.
 */
export const meta = { name: "scheduled-restart-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("scheduled-restart-unit");
  const { decideRestart, describeOutcome, isDue } = await import(
    pathToFileURL(join(repoRoot, "lib", "scheduled-restart.ts")).href
  );

  // --- what to do -----------------------------------------------------------
  {
    const d = decideRestart({ status: "running", crashedAt: null });
    r.check("a running target is restarted", d.action === "restart" && d.reason === "scheduled", JSON.stringify(d));
  }
  {
    const d = decideRestart({ status: "stopped", crashedAt: null });
    r.check("a target stopped on purpose is skipped", d.action === "skip" && d.reason === "stopped", JSON.stringify(d));
  }
  {
    const d = decideRestart({ status: "stopped", crashedAt: "2026-09-22T01:00:00.000Z" });
    r.check("a target that crashed gets one attempt", d.action === "restart" && d.reason === "after-crash", JSON.stringify(d));
  }
  {
    const d = decideRestart({ status: "deploying", crashedAt: null });
    r.check("a deploy in progress is not interrupted", d.action === "skip" && d.reason === "deploying", JSON.stringify(d));
  }
  {
    const d = decideRestart({ status: "error", crashedAt: null });
    r.check("a failed deploy is not retried by a restart", d.action === "skip" && d.reason === "error", JSON.stringify(d));
  }
  {
    // A crash marker written while the row says running is stale — the target
    // came back by itself (Docker's own restart policy) — and the restart is
    // the ordinary scheduled one, not a crash attempt.
    const d = decideRestart({ status: "running", crashedAt: "2026-09-22T01:00:00.000Z" });
    r.check("a stale crash marker on a running target is ignored", d.reason === "scheduled", JSON.stringify(d));
  }

  // --- what gets written down ------------------------------------------------
  {
    r.check("a restart is recorded", describeOutcome({ action: "restart", reason: "scheduled" }, null) === "Riavviato");
    r.check(
      "a recovery is recorded as such",
      describeOutcome({ action: "restart", reason: "after-crash" }, null) === "Riavviato dopo un crash"
    );
    r.check(
      "a failed recovery says so and names the error",
      describeOutcome({ action: "restart", reason: "after-crash" }, "no deploy") === "Tentativo dopo un crash fallito: no deploy"
    );
    r.check(
      "a failed restart names the error",
      describeOutcome({ action: "restart", reason: "scheduled" }, "docker: no such container") ===
        "Riavvio fallito: docker: no such container"
    );
    r.check("a manual stop is explained", describeOutcome({ action: "skip", reason: "stopped" }, null) === "Saltato: fermato a mano");
    r.check("a deploy is explained", describeOutcome({ action: "skip", reason: "deploying" }, null) === "Saltato: deploy in corso");
    r.check("a failed deploy is explained", describeOutcome({ action: "skip", reason: "error" }, null) === "Saltato: ultimo deploy fallito");
  }

  // --- when ------------------------------------------------------------------
  {
    const now = new Date("2026-09-22T10:00:00.000Z");
    r.check("due when the instant has passed", isDue("2026-09-22T09:59:00.000Z", now));
    r.check("due at the exact instant", isDue("2026-09-22T10:00:00.000Z", now));
    r.check("not due before", !isDue("2026-09-22T10:00:30.000Z", now));
    r.check("never due without a schedule", !isDue(null, now));
    r.check("nor with garbage", !isDue("not a date", now));
  }

  return r.result();
}
