import type { Readable } from "stream";
import type {
  BackupArtifactKind,
  BackupArtifactStatus,
  BackupTrigger,
  ProjectsTable,
  ServicesTable,
} from "@/lib/db/schema";

/** What a policy asks for. Mirrors `backupTargetSchema` in lib/validation.ts. */
export type ProjectInclude = "config" | "volumes" | "repo";

export type BackupTarget =
  | { kind: "service"; id: string; databases?: string[] }
  | { kind: "all-services" }
  | { kind: "project"; id: string; include: ProjectInclude[] }
  | { kind: "all-projects"; include: ProjectInclude[] }
  | { kind: "panel" };

/**
 * One unit of work, after the selectors have been resolved against what exists.
 *
 * A target can expand to several jobs — one Postgres service holding three
 * databases is three of them — and each job succeeds or fails on its own, so a
 * single unreachable container does not cost the night's whole backup.
 */
export type BackupJob =
  | { kind: "service-db"; service: ServicesTable; database: string | null }
  | { kind: "panel-store"; includeSecret: boolean }
  | { kind: "project-config"; project: ProjectsTable }
  | { kind: "project-volume"; project: ProjectsTable; volume: string }
  | { kind: "project-repo"; project: ProjectsTable }
  /** A selector that no longer resolves: recorded, never fatal. */
  | { kind: "missing"; targetKind: BackupArtifactKind; refId: string | null; refName: string; reason: string };

/** A file staged on disk, waiting to go into the archive. */
export interface StagedFile {
  /** Absolute path under the run's staging directory. */
  absolutePath: string;
  /** Where it will live inside the archive. */
  entryPath: string;
  bytes: number;
  sha256: string | null;
  /** Already compressed, so the archive should store it rather than deflate it. */
  precompressed: boolean;
}

export interface JobOutcome {
  kind: BackupArtifactKind;
  refId: string | null;
  refName: string;
  status: BackupArtifactStatus;
  /** The archive path, or the shared prefix when the job staged a tree. */
  entryPath: string;
  files: StagedFile[];
  bytes: number;
  sha256: string | null;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface RunContext {
  runId: string;
  stagingDir: string;
  /** Appended to the run log and pushed to anyone watching the stream. */
  log: (line: string) => void;
  signal?: AbortSignal;
}

// --- The manifest, which is also the archive's own documentation -------------

export interface ManifestArtifact {
  kind: BackupArtifactKind;
  refId: string | null;
  refName: string;
  entryPath: string;
  bytes: number;
  sha256: string | null;
  status: BackupArtifactStatus;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface BackupManifest {
  /** Bumped when the layout changes in a way a reader must notice. */
  schemaVersion: 1;
  runId: string;
  policyId: string | null;
  policyName: string | null;
  trigger: BackupTrigger;
  createdAt: string;
  panel: {
    version: string;
    storeDriver: "sqlite" | "postgres";
  };
  artifacts: ManifestArtifact[];
}

// --- Destinations ------------------------------------------------------------

/**
 * Where a finished archive goes.
 *
 * `open` hands back a stream rather than a path on purpose: it is the one
 * decision that decides whether a second destination — Telegram, S3 — is a new
 * file or a refactor of the restore path.
 */
export interface Destination {
  id: string;
  type: string;
  name: string;
  /** Move the finished archive in. Returns the handle used to find it again. */
  put(localPath: string, fileName: string): Promise<{ ref: string; bytes: number }>;
  remove(ref: string): Promise<void>;
  open(ref: string): Promise<Readable>;
  stat(ref: string): Promise<{ bytes: number; exists: boolean }>;
  /** Behind the "Verifica" button, so a broken destination is found before the night it matters. */
  test(): Promise<{ ok: boolean; message: string }>;
}
