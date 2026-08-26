import { Kysely } from "kysely";

/**
 * The contract a deployment actually ran with.
 *
 * `projects.builder_config` holds only what the operator set in the panel. The
 * contract that governs a deploy is that merged over the repository's own
 * `runpanel.json` and over the preset detected from the checkout — and the
 * merged result was never written down anywhere.
 *
 * That is fine while the deploy is running, because it lives in a local
 * variable. It stops being fine at the next **restart**: `restartFromLastDeployment`
 * re-parsed the sparse panel column on its own, so pressing Riavvia brought the
 * app back without the memory limit, the network mode or the env-file mount its
 * `runpanel.json` had contributed. Exactly the class of silent drift that
 * function was extracted to end, one layer further down.
 *
 * Kept sparse on purpose: NULL means a deployment written before this column
 * existed, and the restart falls back to the old behaviour for those rather
 * than refusing to start an app that was running fine.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("deployments").addColumn("resolved_contract", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("deployments").dropColumn("resolved_contract").execute();
}
