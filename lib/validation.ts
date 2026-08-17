import { z } from "zod";
import { isValidTimeZone, parseCron } from "./cron";
import { BRANCH_NAME_RULE, COMMIT_SHA_RULE, isBranchName, isCommitSha } from "./git-ref";
import { parseMountString } from "./mount";
import { ruleProblem } from "./ip-access";



/**
 * `static` belongs here even though the manual runtime picker does not offer
 * it: the "Vite / SPA statica" preset declares it, and picking a preset picks
 * its runtime. Left out, choosing that preset produced a PATCH the schema
 * rejected — the project could not be created at all, with "Dati non validi"
 * and nothing pointing at the runtime. `ProjectsTable.runtime_type` and the
 * builder registry have always known the value.
 */
export const runtimeTypes = ["node", "static", "docker", "compose", "custom"] as const;
export type RuntimeType = (typeof runtimeTypes)[number];

/**
 * Hosts a clone is never allowed to reach.
 *
 * Cloning happens in a subprocess running as the panel, on the panel's network.
 * An unrestricted URL therefore turns "add a project" into a request the caller
 * gets to make from inside the host — a port scan of the LAN, or a read of a
 * cloud metadata endpoint at 169.254.169.254.
 *
 * Literal addresses only: a public name that resolves to a private address
 * still gets through, because git does the resolving and nothing here can pin
 * the answer it gets. Blocking the literals removes the direct route; the
 * token gating in `git-manager.ts` is what limits the damage of the rest.
 *
 * Exported because the same question — "is this address reachable from outside
 * this machine?" — decides whether GitHub can deliver a webhook to the panel's
 * own URL. Asking it twice, in two spellings, is how the two answers end up
 * disagreeing.
 */
export function isBlockedRepoHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;

  // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10)
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;

  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/**
 * A repository URL the panel is willing to clone.
 *
 * `z.string().url()` on its own accepts `file:///etc`, `ssh://…`, `javascript:…`
 * and `http://169.254.169.254/…` — it checks shape, not reachability or scheme.
 */
export const repoUrlSchema = z
  .string()
  .url()
  .refine(
    (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      return url.protocol === "https:" && !isBlockedRepoHost(url.hostname);
    },
    { message: "Repository URL must be a public https:// address" }
  );

/**
 * Who may reach a published port.
 *
 * The messages are exported for the same reason as the two name rules further
 * down: the form renders the sentence the server would, from the same string.
 * The arithmetic lives in `lib/ip-access.ts`, which has no imports of its own
 * so this file stays loadable from a client component.
 */
export const IP_RULE_HINT = "Un indirizzo IP o una rete CIDR, es. 192.168.1.0/24";

/**
 * `/0` is a legal prefix that means everyone. Accepted quietly it would let the
 * panel report «1 rete consentita» over a port open to the internet — true, and
 * the opposite of what it looks like. So it is refused, and the message says
 * what to press instead of what is wrong.
 */
export const IP_RULE_EVERYTHING = "Una rete /0 consente tutti: usa l'interruttore Aperto";

export const accessRuleSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    const problem = ruleProblem(value);
    if (problem === "everything") {
      ctx.addIssue({ code: "custom", message: IP_RULE_EVERYTHING });
    } else if (problem) {
      ctx.addIssue({ code: "custom", message: IP_RULE_HINT });
    }
  });

export const accessSchema = z.object({
  mode: z.enum(["open", "restricted"]),
  /** An empty list under `restricted` means "only this machine". */
  allow: z.array(accessRuleSchema).max(64),
});

/**
 * The two values that reach `git` as arguments, in zod.
 *
 * The rules themselves live in `lib/git-ref.ts`, which has no imports — both so
 * a standalone suite can load them and because they are git's rules, not this
 * file's. Here they only get a schema and a message.
 */
export const commitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isCommitSha, { message: COMMIT_SHA_RULE });

export const branchNameSchema = z
  .string()
  .trim()
  .refine(isBranchName, { message: BRANCH_NAME_RULE });

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  appName: z.string().max(100).optional().nullable(),
  sourceType: z.enum(["github", "upload"]).optional(),
  sourceUrl: repoUrlSchema.optional().nullable(),
  sourceBranch: branchNameSchema.optional(),
  runtimeType: z.enum(runtimeTypes).optional().nullable(),
  port: z.number().int().min(1).max(65535).optional().nullable(),
  autoDeploy: z.boolean().optional(),
  /**
   * How auto-deploy hears about a push: GitHub calling in, or the panel asking.
   * Polling exists for the installations no inbound connection can reach.
   */
  deployTrigger: z.enum(["webhook", "poll"]).optional(),
  /**
   * A deploy preset chosen by hand, applied UNDER whatever the caller also
   * sends. Detection still runs at deploy time; this is the answer for a
   * repository whose shape cannot be seen from outside — or that has not been
   * cloned yet, which is every project at the moment it is configured.
   */
  presetId: z.string().min(1).max(64).optional().nullable(),
  /**
   * The deploy contract, in either the current shape or the older four-field
   * one. It is accepted loosely here and normalised in the route: a strict
   * schema would silently DROP the legacy keys — Zod strips what it does not
   * know — and a project configured through the old wizard would come back with
   * no commands at all.
   */
  builderConfig: z.unknown().optional(),
  /** See `accessSchema`. Changing it restarts the app: the port has to move. */
  access: accessSchema.optional(),
});

export const envVarsSchema = z.object({
  vars: z.array(z.object({
    key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid env var name"),
    value: z.string(),
  })),
});

export const controlActionSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
});

/**
 * What may be asked of a service console.
 *
 * The project terminal it is modelled on reads `body as { action?, input? }`
 * with nothing validating either — the one mutating route in the panel without
 * a schema. This is that route written the way the rest of them are.
 *
 * `confirmed` is checked here rather than only in the dialog for the same
 * reason `restoreRequestSchema` checks its own: the confirmation that counts is
 * the one that cannot be skipped by posting straight at the endpoint. `logs` is
 * exempt because it cannot change anything.
 */
export const consoleModeSchema = z.enum(["engine", "shell", "logs"]);

export const serviceConsoleSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      mode: consoleModeSchema,
      confirmed: z.boolean().optional(),
    })
    .refine((value) => value.mode === "logs" || value.confirmed === true, {
      message: "Serve la conferma prima di aprire una sessione",
      path: ["confirmed"],
    }),
  /** One submitted line. Capped because it reaches a shell's stdin verbatim. */
  z.object({ action: z.literal("input"), input: z.string().max(4096) }),
  z.object({ action: z.literal("stop") }),
]);

/**
 * A directory **on the host** that RunPanel is willing to bind into a container.
 *
 * POSIX absolute, and deliberately nothing else. A Windows path cannot survive
 * the `source:target` mapping this codebase builds — see `lib/mount.ts` for the
 * drive letter that used to become a volume name — and Postgres refuses to run
 * on one regardless, because it cannot set its data directory to 0700. Saying
 * so here is more honest than failing at `docker run`.
 *
 * Two non-empty segments is one rule that refuses `/`, `/etc`, `/var`, `/home`
 * and `/mnt` at once: every path whose whole purpose is to be somebody's
 * parent. The explicit list below is for the ones that are two levels deep and
 * still must never be handed to a container.
 *
 * The panel's own data directory cannot be checked here — `config.dataDir` is
 * server-only and this module is bundled for the browser — so
 * `services/service-mounts.ts` re-runs this schema and adds that one. It is the
 * entry that matters most: `<dataDir>/.secret` decrypts every credential the
 * panel holds.
 */
export const HOST_PATH_RULE =
  "Un percorso assoluto con almeno due livelli, es. /mnt/dati/postgres — niente \"..\"";

const FORBIDDEN_HOST_PATHS = [
  "/proc", "/sys", "/dev", "/boot", "/etc", "/bin", "/sbin", "/lib", "/lib64",
  "/usr", "/var/lib/docker", "/var/run", "/run",
] as const;

export const hostPathSchema = z.string().trim().min(2).max(4096).superRefine((raw, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });

  if (raw.includes("\0") || raw.includes("\\")) return reject(HOST_PATH_RULE);
  if (!raw.startsWith("/")) return reject(HOST_PATH_RULE);

  const segments = raw.split("/").filter(Boolean);
  if (segments.length < 2) return reject(HOST_PATH_RULE);
  if (segments.some((segment) => segment === "." || segment === "..")) return reject(HOST_PATH_RULE);

  const normalised = `/${segments.join("/")}`;
  if (FORBIDDEN_HOST_PATHS.some((bad) => normalised === bad || normalised.startsWith(`${bad}/`))) {
    reject(`${normalised} è una directory di sistema: non può essere montata in un container`);
  }
});

/**
 * A path **inside the container**, which is a different question and a laxer
 * one: it is the container's own filesystem, and mounting over `/etc` or
 * `/usr/share` there is a legitimate thing to want.
 *
 * One level is allowed, unlike the host side — `/data` is where half the
 * official images keep everything. What is refused is the handful that do not
 * produce a differently-configured service but a container that cannot boot:
 * the root itself, and the three kernel filesystems.
 *
 * A colon would split the `source:target` mapping in the wrong place, so it is
 * refused here rather than discovered as a mangled `docker run`.
 */
export const CONTAINER_PATH_RULE =
  "Un percorso assoluto dentro il container, es. /etc/postgresql — niente \"..\"";

const FORBIDDEN_CONTAINER_PATHS = ["/proc", "/sys", "/dev"] as const;

export const containerPathSchema = z.string().trim().min(2).max(4096).superRefine((raw, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });

  if (raw.includes("\0") || raw.includes("\\") || raw.includes(":")) {
    return reject(CONTAINER_PATH_RULE);
  }
  if (!raw.startsWith("/")) return reject(CONTAINER_PATH_RULE);

  const segments = raw.split("/").filter(Boolean);
  if (segments.length < 1) return reject(CONTAINER_PATH_RULE);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return reject(CONTAINER_PATH_RULE);
  }

  const normalised = `/${segments.join("/")}`;
  if (FORBIDDEN_CONTAINER_PATHS.some((bad) => normalised === bad || normalised.startsWith(`${bad}/`))) {
    reject(`${normalised} è un filesystem del kernel: montarci sopra impedisce al container di partire`);
  }
});

/** One bind: a folder on the host appearing at a path inside the container. */
export const serviceMountSchema = z.object({
  /** Stable across edits so a re-ordered list does not look like a new one. */
  id: z.string().min(1).max(32),
  source: hostPathSchema,
  target: containerPathSchema,
  enabled: z.boolean(),
  readOnly: z.boolean(),
});

export const serviceMountsSchema = z.object({
  /** Replace semantics: this is the whole list, not a patch. */
  mounts: z.array(serviceMountSchema).max(32),
  /**
   * The ids whose destination is already non-empty and which the operator has
   * chosen to adopt: mount them as they are and copy nothing. It is them saying
   * "those bytes are the data" — the only way a directory that already holds
   * something is ever used, and why it cannot be the default.
   */
  adopt: z.array(z.string().min(1).max(32)).max(32).optional(),
  /**
   * The ids of data-directory binds the operator agrees to give up. Switching
   * one off puts the engine back on the volume it had before, which is frozen
   * at the moment the bind was made — so the service comes up on an older
   * database while everything written since stays in the host directory.
   */
  releaseData: z.array(z.string().min(1).max(32)).max(32).optional(),
});

/**
 * A mount in the spelling a deploy contract stores: `source:target[:ro]`.
 *
 * Checked here, at the route, and **not** inside `deployContractSchema`.
 * `parseContract` falls back to the whole default contract when parsing fails,
 * so one stale mount string tightened into an error would cost a project its
 * commands, its network and its restart policy at the same time. The contract
 * stays permissive; this is where an operator's input is refused.
 */
export const mountStringSchema = z.string().trim().min(3).max(8192).superRefine((raw, ctx) => {
  const parsed = parseMountString(raw);
  if (!parsed) {
    return ctx.addIssue({ code: "custom", message: "Serve la forma percorso-host:percorso-container" });
  }
  for (const [value, schema] of [
    [parsed.source, hostPathSchema],
    [parsed.target, containerPathSchema],
  ] as const) {
    const result = schema.safeParse(value);
    if (!result.success) {
      ctx.addIssue({ code: "custom", message: result.error.issues[0]?.message ?? HOST_PATH_RULE });
    }
  }
});

/** One row of a project's mount editor, before it is written back as a string. */
export const mountEntrySchema = z.object({
  source: hostPathSchema,
  target: containerPathSchema,
  readOnly: z.boolean(),
  enabled: z.boolean(),
});

export const projectMountsSchema = z.object({
  /** Replace semantics: this is the whole list. */
  mounts: z.array(mountEntrySchema).max(32),
  /**
   * Targets whose host directory is already populated and is adopted as it is.
   * Keyed by container path rather than by an id, because a contract's mounts
   * have never had one.
   */
  adopt: z.array(containerPathSchema).max(32).optional(),
});

/**
 * A directory for a **native** project's checkout.
 *
 * Not `hostPathSchema`, deliberately. That one refuses a Windows path because a
 * `source:target` mapping cannot carry a drive letter — but a PM2 checkout never
 * reaches `docker run -v`. It is a directory the panel's own process reads and
 * writes, on whatever platform it is running, and refusing `D:\dati\progetti`
 * would make the feature unusable on the one the deploy pipeline goes out of its
 * way to support.
 *
 * Two levels for the same reason as the host rule: a path whose whole purpose is
 * to be somebody's parent is not a place to put a checkout.
 */
export const NATIVE_PATH_RULE =
  "Un percorso assoluto con almeno due livelli, es. /mnt/dati/progetti o D:\\dati\\progetti";

export const nativePathSchema = z.string().trim().min(2).max(4096).superRefine((raw, ctx) => {
  const reject = () => ctx.addIssue({ code: "custom", message: NATIVE_PATH_RULE });
  if (raw.includes("\0")) return reject();

  const windows = /^[A-Za-z]:[\\/]/.test(raw);
  if (!windows && !raw.startsWith("/")) return reject();

  const segments = raw.split(/[\\/]/).filter(Boolean);
  // A drive letter is not a level: `C:\dati` is one directory deep.
  const levels = windows ? segments.length - 1 : segments.length;
  if (levels < 2) return reject();
  if (segments.some((segment) => segment === "." || segment === "..")) return reject();
});

export const repoPathSchema = z.object({
  /** `null` puts it back under the panel's own data directory. */
  path: nativePathSchema.nullable(),
});

/**
 * What a deploy request may ask for.
 *
 * `commitSha` is what pins the project to one commit: the route writes it onto
 * the project row, and from then on every deploy rebuilds that commit until the
 * pin is released. It is deliberately not a branch or a tag — see
 * `commitShaSchema` for why the character set is the whole defence.
 */
export const deployRequestSchema = z.object({
  mode: z.enum(["deploy", "rebuild"]).optional(),
  commitSha: commitShaSchema.optional(),
});

/**
 * Releasing the pin, with the redeploy that almost always follows it.
 *
 * One action rather than "clear the pin" plus "now deploy": between the two
 * calls the project sits unpinned while still running the old commit, and a
 * poller tick landing in that gap would be the panel deploying on its own.
 */
export const pinActionSchema = z.object({
  action: z.literal("release"),
  deploy: z.boolean().optional(),
});

/** The commit list behind the version picker. */
export const commitsQuerySchema = z.object({
  branch: branchNameSchema.optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(20).optional(),
});

/**
 * What the panel may ask GitHub to do with a project's webhook.
 *
 * `connect` creates or realigns it, `ping` asks GitHub to send a real delivery,
 * `disconnect` deactivates it without deleting it — so the hook keeps its
 * delivery history on GitHub and turning auto-deploy back on does not have to
 * build a new one.
 */
export const webhookActionSchema = z.object({
  action: z.enum(["connect", "ping", "disconnect"]),
});

/**
 * The panel's own address, as GitHub would have to reach it.
 *
 * Rejects the same private and loopback literals a repository URL is refused
 * for, and for the closer of the two reasons: a hook pointed at `localhost` is
 * accepted by GitHub and then fails every delivery forever, which is exactly
 * the silent failure this whole feature exists to end.
 */
export const PUBLIC_URL_HINT =
  "L'indirizzo pubblico del pannello, es. https://panel.esempio.it — GitHub deve poterlo raggiungere";

export const panelPublicUrlSchema = z
  .string()
  .trim()
  .max(255)
  .superRefine((raw, ctx) => {
    // Empty clears the setting and falls back to the request headers.
    if (raw === "") return;

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: PUBLIC_URL_HINT });
      return;
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({ code: "custom", message: PUBLIC_URL_HINT });
      return;
    }

    if (isBlockedRepoHost(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message: `GitHub non può raggiungere ${url.hostname}: è un indirizzo privato o locale`,
      });
    }
  });

/**
 * A service name is concatenated into a Docker container name and a Docker
 * volume name, so it has to be legal there. Unvalidated, a name with a space or
 * a slash passed every check here and died as a 500 carrying a raw Docker
 * error. Docker's own rule is `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; lowercase-only
 * keeps the names predictable on case-insensitive hosts.
 *
 * The message is exported so the form can render the sentence the server would.
 *
 * The two name rules here look alike enough to be mistaken for one rule stated
 * inconsistently. They are not: a service name becomes a Docker container name,
 * where hyphens are legal; a database name becomes an SQL identifier, where
 * they are not. Keeping each message next to its own regex is what stops them
 * being "reconciled" into a single wrong one.
 */
export const SERVICE_NAME_RULE = "Solo minuscole, numeri, trattini e underscore";

export const serviceNameSchema = z
  .string()
  .min(1)
  .max(38)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, SERVICE_NAME_RULE);

/**
 * A database name goes into `CREATE DATABASE "<name>"`, and an SQL identifier
 * cannot be parameterised — this regex is the whole defence against injection
 * there, not a convenience.
 */
export const DATABASE_NAME_RULE =
  "Deve iniziare con una lettera minuscola; poi solo minuscole, numeri e underscore";

export const databaseNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9_]*$/, DATABASE_NAME_RULE);

export const createDatabaseSchema = z.object({
  name: databaseNameSchema,
});

export const createServiceSchema = z.object({
  name: serviceNameSchema,
  type: z.enum(["postgresql", "mysql", "redis", "mongodb"]),
  version: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  projectId: z.string().optional(),
  credentials: z.object({
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
  }).optional(),
  /** Absent means open, which is what every service was before this existed. */
  access: accessSchema.optional(),
});

/**
 * An environment variable name, as a shell and a Dockerfile will accept it.
 *
 * Uppercase because every convention around connection strings is, and because
 * a lowercase twin of an existing key is the kind of difference nobody sees in
 * a list. Rejecting the leading digit is not style: `2_URL` is not a legal
 * identifier for `export`.
 */
export const envKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, "Solo maiuscole, numeri e underscore, e deve iniziare con una lettera");

/**
 * What can be changed about a service after it exists.
 *
 * There was no PATCH at all, so `project_id` was fixed at creation: detaching a
 * database from a project meant deleting the service, and deleting a service
 * offers to delete its data. Every field here is optional and absent means
 * unchanged — `projectId: null` is the explicit detach.
 */
export const updateServiceSchema = z.object({
  projectId: z.string().min(1).max(32).nullable().optional(),
  injectEnv: z.boolean().optional(),
  envKey: envKeySchema.nullable().optional(),
  access: accessSchema.optional(),
});

// --- Backups ---

/**
 * A backup or restore id reaches the filesystem three times: its log, its
 * archive and its download. This is the check that stops `../../etc/passwd`
 * from becoming a path, so it runs *before* anything is joined — not after.
 */
export const backupIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificativo non valido");

/** Which parts of a project an archive should carry. */
export const projectIncludeSchema = z.enum(["config", "volumes", "repo"]);

/**
 * A target is a selector evaluated when the run starts, not a fixed id — which
 * is what lets `all-services` include the database you create tomorrow.
 */
export const backupTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("service"),
    id: z.string().min(1).max(32),
    /** Omitted means every database on that server. */
    databases: z.array(databaseNameSchema).max(100).optional(),
  }),
  z.object({ kind: z.literal("all-services") }),
  z.object({
    kind: z.literal("project"),
    id: z.string().min(1).max(32),
    include: z.array(projectIncludeSchema).min(1),
  }),
  z.object({
    kind: z.literal("all-projects"),
    include: z.array(projectIncludeSchema).min(1),
  }),
  z.object({ kind: z.literal("panel") }),
]);

/**
 * The expression is checked by the real parser, not by a regex that agrees with
 * it on a good day: the schedule the form accepts and the schedule the tick
 * loop runs have to be the same schedule.
 */
export const cronExpressionSchema = z.string().max(120).superRefine((value, ctx) => {
  const parsed = parseCron(value);
  if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
});

/** A zone the runtime cannot resolve would silently become UTC at tick time. */
export const timeZoneSchema = z
  .string()
  .max(64)
  .refine(isValidTimeZone, "Fuso orario sconosciuto");

export const backupPolicySchema = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().optional(),
  /** Empty means the policy exists but only ever runs when someone asks. */
  cron: z.union([z.literal(""), cronExpressionSchema]),
  timezone: timeZoneSchema.nullable().optional(),
  destinationId: z.string().min(1).max(32),
  targets: z.array(backupTargetSchema).min(1).max(200),
  retentionCount: z.number().int().min(1).max(1000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** A cap below a megabyte would delete every archive as soon as it appeared. */
  retentionBytes: z.number().int().min(1024 * 1024).nullable().optional(),
  includeSecretKey: z.boolean().optional(),
});

export const updateBackupPolicySchema = backupPolicySchema.partial();

export const cronPreviewSchema = z.object({
  cron: cronExpressionSchema,
  timezone: timeZoneSchema.optional(),
  count: z.number().int().min(1).max(10).optional(),
});

/** Only `local` is implemented; adding a transport means adding it here too. */
export const destinationTypes = ["local", "s3"] as const;

/**
 * An S3-compatible destination's configuration.
 *
 * Validated here rather than trusted from the form, because it is stored
 * encrypted and read back at 03:00 by a scheduler nobody is watching: a typo in
 * the endpoint has to be a 400 now, not a failed backup six hours from now.
 */
export const s3ConfigSchema = z.object({
  /**
   * HTTPS towards the internet; plain HTTP allowed only towards a private
   * address.
   *
   * "Always https" was the first rule here and it was wrong in the most common
   * self-hosted case: a MinIO on the LAN, or on the same host, reached over
   * http. SigV4 never puts the secret key on the wire — but with
   * UNSIGNED-PAYLOAD it is TLS that protects the archive itself, and an archive
   * carries every environment variable the panel holds. Over the internet that
   * is not negotiable; inside a private network it is the operator's own wire.
   *
   * `isBlockedRepoHost` is reused deliberately, for the opposite purpose: the
   * set of hosts a clone must never reach is exactly the set where http is
   * acceptable here, and having one definition of "private" is what stops the
   * two drifting apart.
   */
  endpoint: z
    .string()
    .url()
    .refine(
      (raw) => {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          return false;
        }
        if (url.protocol === "https:") return true;
        return url.protocol === "http:" && isBlockedRepoHost(url.hostname);
      },
      { message: "Serve https://, oppure http:// verso un indirizzo privato" }
    ),
  region: z.string().min(1).max(64),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().min(1).max(255),
  secretAccessKey: z.string().min(1).max(255),
  prefix: z.string().max(255).optional(),
  forcePathStyle: z.boolean().optional(),
});

export const destinationSchema = z
  .object({
    name: z.string().min(1).max(60),
    type: z.enum(destinationTypes),
    config: z.record(z.string(), z.unknown()).optional(),
    isDefault: z.boolean().optional(),
  })
  // `local` needs no configuration; `s3` needs all of it, and half a
  // configuration is worse than none — it would be accepted, encrypted, and
  // then fail on first use.
  .refine((value) => value.type !== "s3" || s3ConfigSchema.safeParse(value.config ?? {}).success, {
    message: "Configurazione S3 incompleta o non valida",
    path: ["config"],
  });

/**
 * A restore request.
 *
 * `confirm` carries what the operator typed. It is checked in the browser too,
 * but the check that counts is the one that cannot be skipped by posting
 * directly, and this is the only operation in the panel that can destroy
 * production data.
 */
export const restoreRequestSchema = z
  .object({
    runId: backupIdSchema.optional(),
    uploadId: backupIdSchema.optional(),
    targets: z
      .array(
        z.object({
          artifactId: z.string().min(1).max(64),
          action: z.enum(["restore", "skip"]),
          targetId: z.string().min(1).max(32).optional(),
          targetDatabase: databaseNameSchema.optional(),
        })
      )
      .min(1)
      .max(200),
    /** Off unless the operator went out of their way. */
    skipSafetyBackup: z.boolean().optional(),
    confirm: z.string().min(1).max(200),
  })
  .refine((value) => Boolean(value.runId) !== Boolean(value.uploadId), {
    message: "Indica una run del catalogo oppure un archivio caricato, non entrambi",
    path: ["runId"],
  })
  .refine((value) => value.targets.some((target) => target.action === "restore"), {
    message: "Nessun elemento selezionato per il ripristino",
    path: ["targets"],
  });

// --- Autostart ---

export const autostartEntrySchema = z.object({
  kind: z.enum(["project", "service"]),
  id: z.string().min(1).max(32),
  autostart: z.boolean(),
  order: z.number().int().min(0).max(9999).optional(),
  /** Capped low: a boot that pauses for ten minutes reads as a hung boot. */
  delaySeconds: z.number().int().min(0).max(600).optional(),
  waitHealthy: z.boolean().optional(),
});

export const autostartUpdateSchema = z.object({
  entries: z.array(autostartEntrySchema).min(1).max(500),
});

export const autostartInstallSchema = z.object({
  action: z.enum(["install", "uninstall", "preview"]),
  /** Left out means "whatever the probe decided this host should use". */
  method: z.enum(["systemd", "cron"]).optional(),
});

export const autostartFixSchema = z.object({
  fix: z.enum(["docker-enable", "pm2-save", "restart-policy"]),
  /** Only meaningful for `restart-policy`. */
  target: z.object({ kind: z.enum(["project", "service"]), id: z.string().min(1).max(32) }).optional(),
});
