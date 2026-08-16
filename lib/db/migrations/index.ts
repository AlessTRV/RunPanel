import type { Migration, MigrationProvider } from "kysely/migration";
import * as initial from "./001-initial";
import * as buildLogToFile from "./002-build-log-to-file";
import * as sessionsAndLimits from "./003-sessions-and-limits";
import * as standaloneServices from "./004-standalone-services";
import * as backupsAndAutostart from "./005-backups-and-autostart";
import * as historyIndexes from "./006-history-indexes";
import * as serviceLink from "./007-service-link";
import * as accessRules from "./008-access-rules";
import * as webhookHookId from "./009-webhook-hook-id";
import * as deployPolling from "./010-deploy-polling";
import * as pinnedCommit from "./011-pinned-commit";

/**
 * Migrations are registered statically rather than read from disk with
 * `FileMigrationProvider`: Next bundles this code, so the on-disk layout at
 * runtime is not the source layout and a directory scan would find nothing.
 *
 * Keys are ordered lexicographically by Kysely — keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  "001-initial": initial,
  "002-build-log-to-file": buildLogToFile,
  "003-sessions-and-limits": sessionsAndLimits,
  "004-standalone-services": standaloneServices,
  "005-backups-and-autostart": backupsAndAutostart,
  "006-history-indexes": historyIndexes,
  "007-service-link": serviceLink,
  "008-access-rules": accessRules,
  "009-webhook-hook-id": webhookHookId,
  "010-deploy-polling": deployPolling,
  "011-pinned-commit": pinnedCommit,
};

export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
