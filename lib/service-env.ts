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
