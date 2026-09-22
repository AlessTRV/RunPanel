/**
 * What a scheduled restart does when its moment comes.
 *
 * The rule, stated once and kept free of any import so a unit suite can run
 * the whole matrix without a daemon or a clock:
 *
 *  - a running target is restarted;
 *  - a target somebody stopped on purpose is left alone — a schedule is not a
 *    way of overriding an operator's decision;
 *  - a target that went down by itself gets exactly one attempt. The crash
 *    marker is cleared by the attempt, so a target that will not come back is
 *    tried once, not every night forever — the reconciler writes the marker
 *    again if it crashes again;
 *  - a deploy in progress is never interrupted, and a failed deploy is not
 *    something a restart can fix.
 */

export type RestartDecision =
  | { action: "restart"; reason: "scheduled" | "after-crash" }
  | { action: "skip"; reason: "stopped" | "deploying" | "error" };

export function decideRestart(target: { status: string; crashedAt: string | null }): RestartDecision {
  switch (target.status) {
    case "running":
      return { action: "restart", reason: "scheduled" };
    case "deploying":
      return { action: "skip", reason: "deploying" };
    case "stopped":
      return target.crashedAt
        ? { action: "restart", reason: "after-crash" }
        : { action: "skip", reason: "stopped" };
    default:
      // `error` on a project is a failed deploy; on a service, a container
      // that could not be provisioned. A crash marker on either still means
      // the thing was running once, which is all an attempt needs.
      return target.crashedAt
        ? { action: "restart", reason: "after-crash" }
        : { action: "skip", reason: "error" };
  }
}

/** The line written next to the schedule, so the page can say what happened. */
export function describeOutcome(decision: RestartDecision, error: string | null): string {
  if (decision.action === "skip") {
    switch (decision.reason) {
      case "stopped":
        return "Saltato: fermato a mano";
      case "deploying":
        return "Saltato: deploy in corso";
      case "error":
        return "Saltato: ultimo deploy fallito";
    }
  }
  if (decision.reason === "after-crash") {
    return error ? `Tentativo dopo un crash fallito: ${error}` : "Riavviato dopo un crash";
  }
  return error ? `Riavvio fallito: ${error}` : "Riavviato";
}

export function isDue(nextAt: string | null, now: Date): boolean {
  if (!nextAt) return false;
  const due = Date.parse(nextAt);
  return Number.isFinite(due) && due <= now.getTime();
}
