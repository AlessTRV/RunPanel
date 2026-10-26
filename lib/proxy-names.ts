/**
 * What a domain and a subdomain may look like, decided once.
 *
 * Both end up written verbatim into an nginx `server_name` and into a file
 * name under the proxy's directory, so this is the line between operator text
 * and a configuration a root process loads. The rule is therefore narrower than
 * DNS allows: ASCII letters, digits and hyphens only, lowercase, no wildcard, no
 * trailing dot. A name in another script is written in its `xn--` form, which
 * is what nginx and certbot both expect anyway.
 *
 * No imports, so the standalone suite can load it directly — the same reason
 * `lib/access-columns.ts` has none.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** One DNS label: `app`, `api-v2`, `xn--bcher-kva`. */
export function isDnsLabel(value: string): boolean {
  return LABEL.test(value);
}

/**
 * A domain as the operator registered it: `esempio.it`, `clienti.esempio.it`.
 *
 * Returns the canonical form, or null. At least two labels, because a bare
 * `localhost` or `it` is not something a certificate can be issued for; and a
 * top-level label that is all digits is an IPv4 address, which is not a domain.
 */
export function normalizeDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (value.length === 0 || value.length > 253) return null;

  const labels = value.split(".");
  if (labels.length < 2) return null;
  if (!labels.every(isDnsLabel)) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;

  return value;
}

/** The part before the domain: one label, so it is covered by `*.domain`. */
export function normalizeSubdomain(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return isDnsLabel(value) ? value : null;
}

/** The full name, or null when the two together exceed what DNS allows. */
export function hostnameFor(subdomain: string, domain: string): string | null {
  const hostname = `${subdomain}.${domain}`;
  return hostname.length <= 253 ? hostname : null;
}

/** Whether a stored name still passes, for the renderer's own last check. */
export function isHostname(value: string): boolean {
  return normalizeDomain(value) === value && value.split(".").length >= 3;
}
