/**
 * What a provisioned service is called once it reaches an application.
 *
 * Deliberately free of any Node import: the deploy pipeline needs it to inject
 * the variable, and the env editor needs it to tell the operator which name to
 * expect — and the editor is a client component, so anything reaching for
 * `crypto` or the Docker CLI here would drag the whole provisioner into the
 * browser bundle. Two copies of this mapping would drift, and the symptom would
 * be the panel promising `DATABASE_URL` while the app receives something else.
 */

/** Which env var name an app expects for a given service type. */
export function connectionEnvKey(type: string): string {
  if (type === "redis") return "REDIS_URL";
  if (type === "mongodb") return "MONGODB_URL";
  return "DATABASE_URL";
}

/**
 * The variable a particular link provides.
 *
 * The type default is right for the project with one database and wrong the
 * moment there are two of the same kind: both resolved to `DATABASE_URL`, the
 * first one the loop reached won, and the second reported itself "not linked"
 * in a build log. Storing the name per link is what makes the second database
 * reachable at all.
 */
export function serviceEnvKey(service: { type: string; env_key?: string | null }): string {
  const explicit = service.env_key?.trim();
  return explicit ? explicit : connectionEnvKey(service.type);
}

/**
 * A variable name derived from a service name, offered when two links collide.
 *
 * `analytics` → `ANALYTICS_DATABASE_URL`. Suggested by the server rather than
 * the form, so the create screen and the link editor propose the same thing.
 */
export function suggestEnvKey(serviceName: string, type: string): string {
  const prefix = serviceName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = connectionEnvKey(type);
  if (!prefix || /^[0-9]/.test(prefix)) return base;
  return `${prefix}_${base}`;
}

/**
 * What a project's environment receives from its links.
 *
 * Extracted from the deploy pipeline so the rule can be tested without a Docker
 * daemon: the whole matrix of on/off against a key the project also defines is
 * pure data in, pure data out. It was previously eleven lines in the middle of
 * a 500-line function, reachable only by running a real deploy.
 *
 * The rule, stated once: an enabled link wins. That is the entire contract —
 * the operator turned it on, so the app gets the panel's connection string. The
 * previous rule ("inject unless the project already set a truthy value") was
 * never visible anywhere, and disagreed with every screen that described it.
 */
export interface LinkedService {
  name: string;
  type: string;
  env_key?: string | null;
  inject_env?: number | null;
}

export interface ResolvedInjection {
  /** The variable that was written. */
  key: string;
  service: string;
  value: string;
  /** The project defined this key too, and the link replaced it. */
  replaced: boolean;
}

export interface InjectionConflict {
  key: string;
  /** Service names that all resolve to the same key, in the order found. */
  services: string[];
}

export function resolveServiceEnv<T extends LinkedService>(
  services: readonly T[],
  envVars: Record<string, string>,
  /** Generic so the caller's own row — credentials, ports, container name — arrives intact. */
  connectionFor: (service: T) => string
): { applied: ResolvedInjection[]; skipped: string[]; conflicts: InjectionConflict[] } {
  const applied: ResolvedInjection[] = [];
  const skipped: string[] = [];
  const byKey = new Map<string, string[]>();

  for (const service of services) {
    if (service.inject_env !== 1) {
      skipped.push(service.name);
      continue;
    }

    const key = serviceEnvKey(service);
    const owners = byKey.get(key) ?? [];
    owners.push(service.name);
    byKey.set(key, owners);

    // A second link on the same key does not overwrite the first: the conflict
    // is reported and the first one stands, so the outcome does not depend on
    // row order the way it used to.
    if (owners.length > 1) continue;

    const replaced = Object.prototype.hasOwnProperty.call(envVars, key);
    const value = connectionFor(service);
    envVars[key] = value;
    applied.push({ key, service: service.name, value, replaced });
  }

  const conflicts = [...byKey.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([key, owners]) => ({ key, services: owners }));

  return { applied, skipped, conflicts };
}

/**
 * Build the connection URL for a service.
 *
 * `host` and `port` are the caller's decision, and they travel together: an app
 * on the project network uses the container name and the port the service
 * listens on inside its container, while anything on the host uses `localhost`
 * and the published port. There used to be two implementations of this — one in
 * the templates that always said "localhost", one in the deploy pipeline that
 * was container-aware — so the credentials shown in the UI could disagree with
 * what was actually injected into the app.
 */
export function buildConnectionString(
  type: string,
  opts: { host: string; port: number; user?: string; password?: string; database?: string }
): string {
  const { host, port, user = "", password = "", database = "" } = opts;

  switch (type) {
    case "redis":
      return `redis://${password ? `:${password}@` : ""}${host}:${port}/0`;
    case "mongodb":
      return `mongodb://${user}:${password}@${host}:${port}/${database}`;
    case "mysql":
      return `mysql://${user}:${password}@${host}:${port}/${database}`;
    default:
      return `postgresql://${user}:${password}@${host}:${port}/${database}`;
  }
}

/** Display names, so the UI never prints the raw `postgresql` key. */
export const SERVICE_LABELS: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  redis: "Redis",
  mongodb: "MongoDB",
};

export function serviceLabel(type: string): string {
  return SERVICE_LABELS[type] ?? type;
}
