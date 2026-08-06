import type { Migration, MigrationProvider } from "kysely/migration";
import * as initial from "./001-initial";
import * as buildLogToFile from "./002-build-log-to-file";
import * as sessionsAndLimits from "./003-sessions-and-limits";

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
};

export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
