/**
 * The override that puts a compose stack on the project network.
 *
 * A compose project runs on the network compose creates for it, and the
 * panel's services sit on `runpanel-net-<slug>`. Two networks with no route
 * between them, so an injected `DATABASE_URL` naming the service's container
 * could never resolve, and `host.docker.internal` is a host-gateway address the
 * host's firewall may drop. The fix is to attach the stack's services to the
 * project network — without rewriting the user's file, which is theirs. Compose
 * merges any number of `-f` files, so the attachment is a second file generated
 * at deploy time from the resolved config of the first.
 *
 * Free of any Node import: it turns one object into a string, and that is what
 * lets the unit suite check the result without a daemon.
 */

/** The relevant part of what `docker compose config --format json` prints. */
export interface ResolvedComposeConfig {
  services?: Record<
    string,
    { network_mode?: string | null; networks?: Record<string, unknown> | string[] | null } | null
  >;
}

export interface ComposeNetworkOverride {
  /** The override file: YAML, in its JSON subset, which compose reads the same way. */
  text: string;
  /** Services the override attaches to the project network. */
  attached: string[];
  /** Services that cannot be attached: `network_mode` excludes `networks`. */
  skipped: string[];
}

/** The alias the override uses inside the stack for the project network. */
export const OVERRIDE_NETWORK_KEY = "runpanel";

/**
 * Build the override for `config`, or null when there is nothing to attach.
 *
 * Every service already on a set of networks keeps them: compose merges the
 * `networks` of a service across files as a mapping, so naming a network here
 * with no options adds it without touching what the base file says about the
 * others. A service with no `networks` at all is on `default` only because the
 * list is empty — once the override names one, `default` has to be named too,
 * or the service silently leaves the network its own stack talks over. The
 * resolved config already shows `default` explicitly, which is why it is read
 * rather than assumed.
 */
export function composeNetworkOverride(
  config: ResolvedComposeConfig,
  slug: string
): ComposeNetworkOverride | null {
  const services = config.services ?? {};
  const attached: string[] = [];
  const skipped: string[] = [];
  const overrideServices: Record<string, { networks: Record<string, Record<string, never>> }> = {};

  for (const [name, service] of Object.entries(services)) {
    if (service?.network_mode) {
      skipped.push(name);
      continue;
    }

    const existing = Array.isArray(service?.networks)
      ? service.networks
      : Object.keys(service?.networks ?? {});
    const names = existing.length > 0 ? existing : ["default"];

    const networks: Record<string, Record<string, never>> = {};
    for (const key of names) networks[key] = {};
    networks[OVERRIDE_NETWORK_KEY] = {};

    overrideServices[name] = { networks };
    attached.push(name);
  }

  if (attached.length === 0) return null;

  const doc = {
    networks: {
      [OVERRIDE_NETWORK_KEY]: { external: true, name: `runpanel-net-${slug}` },
    },
    services: overrideServices,
  };

  return { text: `${JSON.stringify(doc, null, 2)}\n`, attached, skipped };
}
