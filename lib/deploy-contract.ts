import { z } from "zod";

/**
 * What RunPanel needs to know to deploy a project.
 *
 * The fields are deliberately RUNTIME-NEUTRAL. Each driver maps them to its own
 * mechanism — `buildEnv` becomes `--build-arg` under Docker and plain build-time
 * environment under PM2; `envFile` is a read-only mount in one case and a file
 * written into the working directory in the other. Nothing here is specific to
 * any one project: a project that needs something RunPanel cannot express means
 * the contract is incomplete, not that the project needs special-casing.
 *
 * A repository can ship its own `runpanel.json` with the same shape, so a
 * project can declare how it wants to be deployed without RunPanel knowing
 * anything about it in advance.
 */

const shellCommand = z.string().max(4000);

export const restartPolicies = ["no", "on-failure", "unless-stopped", "always"] as const;
export const networkModes = ["project", "bridge", "host"] as const;
export const packageManagers = ["auto", "npm", "bun", "pnpm", "yarn"] as const;

/**
 * Prefixes whose values a frontend build inlines into the client bundle. They
 * have to be present at BUILD time — supplying them only at runtime silently
 * ships the wrong value, or fails the build outright when the Dockerfile
 * asserts on them.
 */
export const DEFAULT_BUILD_ENV_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_", "REACT_APP_"];

export const deployContractSchema = z.object({
  version: z.literal(1).default(1),

  commands: z
    .object({
      install: shellCommand.optional(),
      build: shellCommand.optional(),
      start: shellCommand.optional(),
      /**
       * Runs once per deploy, after the build and before the app starts —
       * migrations, schema push, cache warm. Its failure fails the deploy.
       */
      release: shellCommand.optional(),
    })
    .default({}),

  packageManager: z.enum(packageManagers).default("auto"),

  /** Values passed to the build, in addition to those matched by the prefixes. */
  buildEnv: z.record(z.string(), z.string()).default({}),
  buildEnvPrefixes: z.array(z.string()).default(DEFAULT_BUILD_ENV_PREFIXES),

  envFile: z
    .object({
      /**
       * Materialise the project's environment as a real file.
       *
       * Some apps read a .env themselves rather than trusting the process
       * environment. Docker's own `--env-file` is not a substitute: it does not
       * strip quotes, so a quoted value arrives with the quotes attached.
       */
      enabled: z.boolean().default(false),
      /** Where the app expects it. Inside the container for Docker runtimes. */
      path: z.string().default("/app/.env"),
    })
    .default({ enabled: false, path: "/app/.env" }),

  docker: z
    .object({
      /** Template mode: use a prebuilt image instead of building. */
      image: z.string().optional(),
      dockerfile: z.string().optional(),
      context: z.string().default("."),
      target: z.string().optional(),
      network: z.enum(networkModes).default("project"),
      /** Useful with `network: host`, to stop the app binding every interface. */
      hostname: z.string().optional(),
      capAdd: z.array(z.string()).default([]),
      extraHosts: z.array(z.string()).default([]),
      /** Extra volume mounts, `source:target[:ro]`. */
      mounts: z.array(z.string()).default([]),
    })
    .default({ context: ".", network: "project", capAdd: [], extraHosts: [], mounts: [] }),

  runtime: z
    .object({
      restartPolicy: z.enum(restartPolicies).default("unless-stopped"),
      /** Docker memory limit, e.g. "2g". */
      memory: z.string().optional(),
      /** Docker CPU limit, e.g. "1.5". */
      cpus: z.string().optional(),
      /** /dev/shm size. The 64MB default kills browser-style workloads. */
      shmSize: z.string().optional(),
      /**
       * Refuse to start a second instance. For apps holding state in process
       * memory, where two live copies is not slower but wrong.
       */
      singleInstance: z.boolean().default(false),
    })
    .default({ restartPolicy: "unless-stopped", singleInstance: false }),

  build: z
    .object({
      /** e.g. "--max-old-space-size=4096" for a build that OOMs. */
      nodeOptions: z.string().optional(),
      timeoutSec: z.number().int().min(30).max(7200).default(900),
    })
    .default({ timeoutSec: 900 }),

  healthcheck: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().default("/"),
      /** Defaults to the project's port. */
      port: z.number().int().min(1).max(65535).optional(),
      /** Empty means "any HTTP response counts" — the port is what matters. */
      expectStatus: z.array(z.number().int()).default([]),
      /** Grace before probing at all. Slow boots need this or they look dead. */
      startPeriodSec: z.number().int().min(0).max(600).default(3),
      /** Total budget after the start period. */
      timeoutSec: z.number().int().min(5).max(900).default(30),
      intervalSec: z.number().int().min(1).max(30).default(2),
    })
    .default({
      enabled: true,
      path: "/",
      expectStatus: [],
      startPeriodSec: 3,
      timeoutSec: 30,
      intervalSec: 2,
    }),
});

export type DeployContract = z.infer<typeof deployContractSchema>;

/**
 * The shape older projects stored in `builder_config`. Accepted so an existing
 * project keeps deploying after the upgrade without being touched.
 */
const legacySchema = z.object({
  installCmd: z.string().optional(),
  buildCmd: z.string().optional(),
  startCmd: z.string().optional(),
  packageManager: z.enum(packageManagers).optional(),
  dockerImage: z.string().optional(),
  dockerTemplate: z.string().optional(),
  dockerFields: z.record(z.string(), z.string()).optional(),
});

type RawObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translate the old four-field shape into the current one, WITHOUT applying
 * defaults. Keeping it partial is what lets a repository contract fill in
 * everything the panel did not explicitly set.
 */
export function normalizeContractInput(raw: unknown): RawObject {
  return normalizeRaw(raw);
}

function normalizeRaw(raw: unknown): RawObject {
  if (!isPlainObject(raw)) return {};
  if (raw.version === 1) return raw;

  const parsed = legacySchema.safeParse(raw);
  if (!parsed.success) return {};

  const legacy = parsed.data;
  const out: RawObject = {};

  const commands: RawObject = {};
  if (legacy.installCmd) commands.install = legacy.installCmd;
  if (legacy.buildCmd) commands.build = legacy.buildCmd;
  if (legacy.startCmd) commands.start = legacy.startCmd;
  if (Object.keys(commands).length > 0) out.commands = commands;

  if (legacy.packageManager) out.packageManager = legacy.packageManager;
  if (legacy.dockerImage) out.docker = { image: legacy.dockerImage };

  return out;
}

/**
 * Recursive merge where `override` wins. Arrays are replaced rather than
 * concatenated — a caller who sets `capAdd: []` means "none", not "keep
 * whatever was there".
 */
function deepMerge(base: RawObject, override: RawObject): RawObject {
  const out: RawObject = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }

  return out;
}

/**
 * Parse whatever is stored for a project into a complete contract.
 * Never throws: an unreadable config yields defaults rather than an
 * undeployable project.
 */
export function parseContract(raw: unknown): DeployContract {
  const result = deployContractSchema.safeParse(normalizeRaw(raw));
  return result.success ? result.data : deployContractSchema.parse({});
}

export function parseContractJson(json: string | null | undefined): DeployContract {
  if (!json) return deployContractSchema.parse({});
  try {
    return parseContract(JSON.parse(json));
  } catch {
    return deployContractSchema.parse({});
  }
}

/**
 * Combine a repository's own `runpanel.json` with the panel's settings.
 *
 * Both sides are merged RAW, before defaults are filled in. That distinction is
 * the whole feature: once a schema default has been applied there is no way to
 * tell "the operator chose 3" from "nobody set it and 3 is the default", so a
 * repository value could never win on any field that has a default — which is
 * nearly all of them.
 *
 * Where both sides set the same field the panel wins: the operator can see the
 * target machine, the repository cannot.
 */
export function resolveContract(panelRaw: unknown, repoRaw: unknown): DeployContract {
  const panel = normalizeRaw(panelRaw);
  if (!isPlainObject(repoRaw)) return parseContract(panel);

  const merged = deepMerge(normalizeRaw(repoRaw), panel);
  const result = deployContractSchema.safeParse(merged);
  return result.success ? result.data : parseContract(panel);
}

/** Same, taking the panel side as the JSON string stored on the project. */
export function resolveContractJson(panelJson: string | null | undefined, repoRaw: unknown): DeployContract {
  let panelRaw: unknown = {};
  try {
    panelRaw = panelJson ? JSON.parse(panelJson) : {};
  } catch {
    panelRaw = {};
  }
  return resolveContract(panelRaw, repoRaw);
}

/**
 * Split a project's environment into what the build needs and what the running
 * process needs. Build args are additionally reported so the deploy log can
 * name them without printing the values.
 */
export function selectBuildEnv(
  contract: DeployContract,
  envVars: Record<string, string>
): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    if (contract.buildEnvPrefixes.some((prefix) => key.startsWith(prefix))) {
      selected[key] = value;
    }
  }

  // Explicit entries win over prefix matching.
  return { ...selected, ...contract.buildEnv };
}

export interface PreflightIssue {
  field: string;
  message: string;
}

/**
 * Catch what can be known before a build starts.
 *
 * A ten-minute image build that fails on a missing build arg is a bad way to
 * find out the value was never set.
 */
export function preflight(
  contract: DeployContract,
  ctx: { runtimeType: string; envVars: Record<string, string>; repoDir?: string }
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const isDocker = ctx.runtimeType === "docker";

  for (const [key, value] of Object.entries(contract.buildEnv)) {
    if (value === "") {
      issues.push({
        field: `buildEnv.${key}`,
        message: `Build arg "${key}" è dichiarato ma vuoto. Molti build falliscono o compilano il valore sbagliato.`,
      });
    }
  }

  if (!isDocker) {
    if (contract.docker.network === "host") {
      issues.push({
        field: "docker.network",
        message: "network: host vale solo per i runtime Docker; verrà ignorato.",
      });
    }
    if (contract.runtime.shmSize || contract.runtime.cpus) {
      issues.push({
        field: "runtime",
        message: "I limiti di CPU e shm si applicano solo ai container; verranno ignorati.",
      });
    }
  }

  if (contract.envFile.enabled && !contract.envFile.path.trim()) {
    issues.push({ field: "envFile.path", message: "Il percorso del file .env è vuoto." });
  }

  if (contract.healthcheck.enabled && !contract.healthcheck.path.startsWith("/")) {
    issues.push({
      field: "healthcheck.path",
      message: `Il path dell'healthcheck deve iniziare con "/" (attuale: "${contract.healthcheck.path}").`,
    });
  }

  return issues;
}
