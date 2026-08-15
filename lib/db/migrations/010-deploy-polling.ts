import { Kysely } from "kysely";

/**
 * Auto-deploy for panels the internet cannot reach.
 *
 * A webhook needs GitHub to open a connection *to* this machine, and a great
 * many installations of a self-hosted panel are exactly where that cannot
 * happen: behind NAT with no port forwarded, on a Tailscale or WireGuard
 * network, on a laptop. There is nothing to fix in the webhook path for those —
 * the delivery fails before it arrives, and no amount of correct configuration
 * on either side changes it.
 *
 * So the panel can also ask instead of being told: check the branch on a timer,
 * deploy when the commit it points at changes. Same outcome, an outbound
 * request instead of an inbound one, and it needs nothing of the network.
 *
 *   deploy_trigger    'webhook' | 'poll' — NULL reads as 'webhook', which is
 *                     what every existing project already does
 *   poll_sha          the commit last seen on the branch; the poller deploys
 *                     when what it reads differs from this
 *   poll_checked_at   when it last managed to look, so the panel can say
 *                     whether polling is actually running
 */
const POLL_COLUMNS = [
  ["deploy_trigger", "text"],
  ["poll_sha", "text"],
  ["poll_checked_at", "text"],
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER, so
  // chaining them would compile to valid Postgres and invalid SQLite.
  for (const [column, type] of POLL_COLUMNS) {
    await db.schema.alterTable("projects").addColumn(column, type).execute();
  }

  /*
    Left NULL rather than backfilled to 'webhook'.

    The column means "what the operator chose", and nobody has chosen yet. A
    backfill would make every project look like a deliberate webhook decision,
    and the panel could no longer tell an untouched project from one someone
    picked webhooks for — which is exactly the difference it needs to suggest
    polling to an installation the internet cannot reach.
  */
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [column] of [...POLL_COLUMNS].reverse()) {
    await db.schema.alterTable("projects").dropColumn(column).execute();
  }
}
