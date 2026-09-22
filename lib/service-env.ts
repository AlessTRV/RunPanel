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

/**
 * Where a project's app calls its services from.
 *
 * Two answers, and the runtime decides. A native process (PM2) sits on the
 * host: it reaches a service on `localhost` at the port published there. A
 * container does not — inside it `localhost` is the container itself, and
 * `host.docker.internal` is a host-gateway address that a firewall on the host
 * is free to drop, which is exactly what happened on a server whose ufw let
 * nothing but the VPN interface into Docker. The one address that always works
 * from a container is the service's own name on the project network, which is
 * why every container runtime is put on that network and reaches the service
 * that way. The only container that is not is one sharing the host's stack
 * (`network: host`, or a compose stack entirely on `network_mode: host`):
 * for it `localhost` is the host again.
 *
 * A function, and here, because the answer is needed in three places that
 * must agree: the deploy pipeline builds the URL it injects from it, the
 * service page shows the operator which line to copy, and the project page
 * says which host the link will hand over. They did not agree, once.
 */
export type ConnectionOrigin = "host" | "container";

export function connectionOrigin(runtimeType: string, dockerNetwork?: string | null): ConnectionOrigin {
  if (runtimeType === "docker" || runtimeType === "compose") {
    return dockerNetwork === "host" ? "host" : "container";
  }
  return "host";
}

/**
 * The port a service listens on inside its container, by type.
 *
 * Not the port stored on the row — that is where it is published on the host,
 * and it moves when the default is taken. Inside the project network the
 * published mapping does not exist, so a Postgres published on 5433 is still
 * reached on 5432. The provisioner reads the same number from the template;
 * this copy is what lets the URL be built where the templates cannot be
 * imported (the browser, a unit test).
 */
const CONTAINER_PORTS: Record<string, number> = {
  postgresql: 5432,
  mysql: 3306,
  redis: 6379,
  mongodb: 27017,
};

export function containerPort(type: string): number | undefined {
  return CONTAINER_PORTS[type];
}

export interface ConnectableService {
  type: string;
  /** Published on the host. */
  port: number;
  /** Listening inside the container; the type's default when absent. */
  internalPort?: number | null;
  containerName: string;
  credentials?: { user?: string; password?: string; database?: string } | null;
}

/** Host and port as seen from `from`. */
export function serviceEndpoint(
  service: Pick<ConnectableService, "type" | "port" | "internalPort" | "containerName">,
  from: ConnectionOrigin
): { host: string; port: number } {
  if (from === "container") {
    return {
      host: service.containerName,
      port: service.internalPort ?? containerPort(service.type) ?? service.port,
    };
  }
  return { host: "localhost", port: service.port };
}

/**
 * The connection URL a project receives for a service — the one function the
 * deploy, the restart and both pages build it from.
 *
 * `project` is what decides the viewpoint; `from` overrides it for a page that
 * wants to show the other one. No project at all is a standalone service, and
 * the only thing there is to say about it is how to reach it from the host.
 */
export function serviceConnectionUrl(
  service: ConnectableService,
  project: { runtime_type: string; dockerNetwork?: string | null } | null,
  opts: { from?: ConnectionOrigin } = {}
): string {
  const from =
    opts.from ?? (project ? connectionOrigin(project.runtime_type, project.dockerNetwork) : "host");
  const { host, port } = serviceEndpoint(service, from);
  return buildConnectionString(service.type, { host, port, ...(service.credentials ?? {}) });
}

/**
 * The URL with its password hidden, for a log.
 *
 * The deploy log used to say only that a variable had been replaced. With the
 * host in the line the operator sees at once whether the app was handed a
 * container name or `localhost` — which is the whole question when a database
 * cannot be reached — and never the password.
 */
export function maskUrlPassword(url: string): string {
  const scheme = url.indexOf("://");
  if (scheme === -1) return url;
  const at = url.lastIndexOf("@");
  if (at === -1) return url;
  const colon = url.indexOf(":", scheme + 3);
  if (colon === -1 || colon > at) return url;
  return `${url.slice(0, colon + 1)}***${url.slice(at)}`;
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
