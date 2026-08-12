import { z } from "zod";
import path from "path";

/**
 * RunPanel's own configuration, read from the environment exactly once and
 * validated up front. Anything that is not in here is not configuration.
 *
 * Validation is lazy (first `getEnv()` call) rather than at import time so that
 * `next build` — which imports every route module for analysis — does not need
 * a valid runtime environment. `instrumentation.ts` calls `getEnv()` at server
 * start, so a misconfigured deployment still fails at boot rather than on the
 * first request that happens to touch the database.
 */

/** Treat empty strings as absent — `FOO=` in a .env file should mean "unset". */
function readRawEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

const sslModes = ["disable", "require", "no-verify"] as const;

const envSchema = z
  .object({
    RUNPANEL_DATA_DIR: z.string().optional(),
    RUNPANEL_SECRET: z
      .string()
      .regex(/^[0-9a-fA-F]+$/, "RUNPANEL_SECRET must be a hex string")
      .min(64, "RUNPANEL_SECRET must be at least 64 hex chars (32 bytes)")
      .optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /**
     * Silences the background timers — housekeeping, backups, the boot
     * reconciler. The test runner starts one server per suite on one machine,
     * and without this every one of them would begin dumping databases.
     *
     * Spelled out rather than coerced: `z.coerce.boolean()` reads "0" as true,
     * which is precisely the value someone types to turn a flag off.
     */
    RUNPANEL_DISABLE_SCHEDULERS: z.enum(["1", "0", "true", "false", "yes", "no"]).optional(),

    /**
     * How many reverse proxies sit in front of the panel.
     *
     * `X-Forwarded-For` is a list that each hop APPENDS to, so the leftmost
     * entry is the one the client sent — the value an attacker picks, not the
     * address they connected from. Reading it defeated the login rate limit
     * entirely: a different value per request meant a different counter per
     * request. The trustworthy entry is the nth from the RIGHT, where n is the
     * number of proxies you actually run.
     *
     * 0 (the default) ignores the header and uses the socket address, which is
     * correct for a panel reached directly.
     */
    RUNPANEL_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    RUNPANEL_DB_DRIVER: z.enum(["sqlite", "postgres"]).default("sqlite"),

    // sqlite
    RUNPANEL_DB_FILE: z.string().optional(),

    // postgres — full URL (preferred) or discrete credentials
    RUNPANEL_DATABASE_URL: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    RUNPANEL_PG_HOST: z.string().optional(),
    RUNPANEL_PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    RUNPANEL_PG_USER: z.string().optional(),
    RUNPANEL_PG_PASSWORD: z.string().optional(),
    RUNPANEL_PG_DATABASE: z.string().optional(),
    RUNPANEL_PG_SSL: z.enum(sslModes).default("disable"),
    RUNPANEL_PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  })
  .superRefine((v, ctx) => {
    if (v.RUNPANEL_DB_DRIVER !== "postgres") return;

    const hasUrl = Boolean(v.RUNPANEL_DATABASE_URL || v.DATABASE_URL);
    const hasParts = Boolean(v.RUNPANEL_PG_HOST && v.RUNPANEL_PG_USER && v.RUNPANEL_PG_DATABASE);

    if (!hasUrl && !hasParts) {
      ctx.addIssue({
        code: "custom",
        path: ["RUNPANEL_DATABASE_URL"],
        message:
          'RUNPANEL_DB_DRIVER="postgres" requires either RUNPANEL_DATABASE_URL (or DATABASE_URL), ' +
          "or all of RUNPANEL_PG_HOST + RUNPANEL_PG_USER + RUNPANEL_PG_DATABASE.",
      });
    }
  });

export type SslMode = (typeof sslModes)[number];

export type DbConfig =
  | { driver: "sqlite"; file: string }
  | {
      driver: "postgres";
      connectionString?: string;
      host?: string;
      port: number;
      user?: string;
      password?: string;
      database?: string;
      ssl: SslMode;
      poolMax: number;
    };

export interface RunPanelEnv {
  dataDir: string;
  /** Explicit secret from the environment. When absent, a file-backed one is generated. */
  secret?: string;
  port: number;
  /** When true, nothing schedules itself at boot. */
  disableSchedulers: boolean;
  /** Reverse proxies in front of the panel. 0 means trust no `X-Forwarded-For`. */
  trustedProxyHops: number;
  db: DbConfig;
}

let cached: RunPanelEnv | null = null;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${at}: ${issue.message}`;
    })
    .join("\n");
}

export function getEnv(): RunPanelEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(readRawEnv());
  if (!parsed.success) {
    throw new Error(
      `[RunPanel] Invalid environment configuration:\n${formatIssues(parsed.error)}\n` +
        "See .env.example for the full contract."
    );
  }

  const v = parsed.data;
  const dataDir = path.resolve(v.RUNPANEL_DATA_DIR ?? path.join(process.cwd(), "data"));

  const db: DbConfig =
    v.RUNPANEL_DB_DRIVER === "postgres"
      ? {
          driver: "postgres",
          connectionString: v.RUNPANEL_DATABASE_URL ?? v.DATABASE_URL,
          host: v.RUNPANEL_PG_HOST,
          port: v.RUNPANEL_PG_PORT,
          user: v.RUNPANEL_PG_USER,
          password: v.RUNPANEL_PG_PASSWORD,
          database: v.RUNPANEL_PG_DATABASE,
          ssl: v.RUNPANEL_PG_SSL,
          poolMax: v.RUNPANEL_PG_POOL_MAX,
        }
      : {
          driver: "sqlite",
          file: v.RUNPANEL_DB_FILE
            ? path.resolve(v.RUNPANEL_DB_FILE)
            : path.join(dataDir, "runpanel.db"),
        };

  const disableSchedulers = ["1", "true", "yes"].includes(
    v.RUNPANEL_DISABLE_SCHEDULERS ?? ""
  );

  cached = {
    dataDir,
    secret: v.RUNPANEL_SECRET,
    port: v.PORT,
    disableSchedulers,
    trustedProxyHops: v.RUNPANEL_TRUSTED_PROXY_HOPS,
    db,
  };
  return cached;
}

/**
 * Environment variables that belong to RunPanel itself and must never reach a
 * user's build command or deployed process.
 *
 * `RUNPANEL_SECRET` is the AES key that every project's stored env vars are
 * encrypted with — a build script that can read it can decrypt every secret in
 * the panel. The database variables matter for a different reason: a deployed
 * app that inherits RunPanel's `DATABASE_URL` and has no database of its own
 * would happily connect to RunPanel's own store.
 */
export const PRIVATE_ENV_KEYS: readonly string[] = [
  "RUNPANEL_SECRET",
  "RUNPANEL_DATA_DIR",
  "RUNPANEL_DISABLE_SCHEDULERS",
  "RUNPANEL_DB_DRIVER",
  "RUNPANEL_DB_FILE",
  "RUNPANEL_DATABASE_URL",
  "DATABASE_URL",
  "RUNPANEL_PG_HOST",
  "RUNPANEL_PG_PORT",
  "RUNPANEL_PG_USER",
  "RUNPANEL_PG_PASSWORD",
  "RUNPANEL_PG_DATABASE",
  "RUNPANEL_PG_SSL",
  "RUNPANEL_PG_POOL_MAX",
];

const PRIVATE_ENV_SET = new Set(PRIVATE_ENV_KEYS.map((k) => k.toLowerCase()));

/** A copy of `process.env` with RunPanel's own configuration removed. */
export function sanitizedProcessEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(out)) {
    if (PRIVATE_ENV_SET.has(key.toLowerCase())) delete out[key];
  }
  return out;
}
