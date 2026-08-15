/**
 * Who is allowed to reach a published port, and which networks to offer.
 *
 * This is the first CIDR arithmetic in the repo. `isBlockedRepoHost` in
 * `lib/validation.ts` classifies an address as private or not, which is a
 * different question with a fixed answer; here the operator supplies the
 * networks and the gate has to decide, per connection, whether a source falls
 * inside one of them.
 *
 * **Zero imports, and it has to stay that way.** Two constraints meet here:
 * `lib/validation.ts` imports this file and is itself imported by client
 * components, so a `node:os` in this module would be dragged into a browser
 * bundle; and the standalone test suite loads this file directly by URL, where
 * Node resolves neither extensionless relative specifiers nor the `@/` alias.
 * That is why `networksFrom` takes the interface map as an argument and
 * declares its own structural shape for it instead of importing `os` — the one
 * caller that has an `os` reads it and passes it in.
 */

export interface AccessRule {
  /** Canonical text: host bits masked off, so `192.168.1.14/24` stores as `192.168.1.0/24`. */
  readonly text: string;
  readonly family: 4 | 6;
  /** Network address, big-endian: 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: Uint8Array;
  readonly bits: number;
}

/**
 * Why a string is not a usable rule.
 *
 * Codes rather than sentences: the Italian copy belongs next to the schema in
 * `lib/validation.ts`, where every other user-facing message in this codebase
 * lives, and duplicating it here is how the two would drift.
 */
export type RuleProblem = "syntax" | "everything";

const IPV4_GROUP = /^(0|[1-9]\d{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/**
 * Parse dotted-quad IPv4 into 4 bytes.
 *
 * Leading zeros are rejected rather than accepted-and-interpreted. `010.0.0.1`
 * is 8.0.0.1 to a C resolver and 10.0.0.1 to a naive one, and an allowlist that
 * disagrees with the kernel about which host it just admitted is worse than one
 * that refuses to guess.
 */
function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!IPV4_GROUP.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Parse an IPv6 literal into 16 bytes, including the `::ffff:1.2.3.4` form. */
function parseIpv6(text: string): Uint8Array | null {
  let s = text.toLowerCase();

  // A trailing dotted quad occupies the last two groups. Swapping it for two
  // zero groups keeps the group arithmetic below in one shape; the real bytes
  // are written back at the end.
  let tail: Uint8Array | null = null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    tail = parseIpv4(s.slice(lastColon + 1));
    if (!tail) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  if (rest === null) {
    if (head.length !== 8) return null;
  } else if (head.length + rest.length > 7) {
    // `::` stands for at least one group of zeros, so a full eight-group
    // address written with one is malformed.
    return null;
  }

  const groups: number[] = [];
  for (const group of head) {
    if (!IPV6_GROUP.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  if (rest !== null) {
    const zeros = 8 - head.length - rest.length;
    for (let i = 0; i < zeros; i++) groups.push(0);
    for (const group of rest) {
      if (!IPV6_GROUP.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  if (tail) bytes.set(tail, 12);

  return bytes;
}

/** True when the 16 bytes are an IPv4-mapped IPv6 address (`::ffff:0:0/96`). */
function isV4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

export interface ParsedAddress {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
}

/**
 * Parse an address the way it arrives from a socket.
 *
 * `socket.remoteAddress` on a dual-stack listener reports IPv4 peers as
 * `::ffff:192.168.1.14`, so an allowlist that only understood IPv6 there would
 * reject every rule the operator wrote in IPv4 — which is all of them. The
 * mapped form is folded back to IPv4 for exactly that reason. Link-local
 * addresses carry a zone (`fe80::1%eth0`) that belongs to the interface, not
 * the host, and is dropped.
 */
export function parseAddress(raw: string): ParsedAddress | null {
  if (!raw) return null;

  let text = raw.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text) return null;

  if (text.includes(":")) {
    const bytes = parseIpv6(text);
    if (!bytes) return null;
    if (isV4Mapped(bytes)) return { family: 4, bytes: bytes.slice(12) };
    return { family: 6, bytes };
  }

  const bytes = parseIpv4(text);
  return bytes ? { family: 4, bytes } : null;
}

function formatIpv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/** Canonical IPv6 text: lowercase hex, the longest zero run collapsed to `::`. */
function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2] << 8) | bytes[i * 2 + 1]);

  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const length = i - start;
      // Only a run of two or more is worth collapsing: `::` for a single zero
      // group is legal but longer than the digit it replaces.
      if (length > bestLength && length > 1) {
        bestStart = start;
        bestLength = length;
      }
      start = -1;
    }
  }

  const parts = groups.map((g) => g.toString(16));
  if (bestStart === -1) return parts.join(":");

  const head = parts.slice(0, bestStart).join(":");
  const tail = parts.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/** The address as the panel writes it: canonical, and IPv4 where it can be. */
export function normalizeAddress(raw: string): string | null {
  const parsed = parseAddress(raw);
  if (!parsed) return null;
  return parsed.family === 4 ? formatIpv4(parsed.bytes) : formatIpv6(parsed.bytes);
}

function maskBytes(bytes: Uint8Array, bits: number): Uint8Array {
  const masked = new Uint8Array(bytes);
  for (let i = 0; i < masked.length; i++) {
    const consumed = i * 8;
    if (consumed >= bits) {
      masked[i] = 0;
    } else if (bits - consumed < 8) {
      masked[i] &= (0xff << (8 - (bits - consumed))) & 0xff;
    }
  }
  return masked;
}

/**
 * Why `text` cannot be used as a rule, or null if it can.
 *
 * `/0` gets its own answer rather than being accepted quietly. It is a valid
 * prefix that happens to mean "everyone", so a panel that took it would show
 * "1 rete consentita" over a port open to the internet — the summary would be
 * true and the impression it gives would be the opposite of the truth.
 */
export function ruleProblem(text: string): RuleProblem | null {
  const trimmed = text.trim();
  if (!trimmed) return "syntax";

  const slash = trimmed.lastIndexOf("/");
  const addressPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const parsed = parseAddress(addressPart);
  if (!parsed) return "syntax";

  if (slash === -1) return null;

  const suffix = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(suffix)) return "syntax";

  const bits = Number(suffix);
  const width = parsed.family === 4 ? 32 : 128;
  if (bits > width) return "syntax";
  if (bits === 0) return "everything";

  return null;
}

/**
 * Turn operator text into a rule, or null if it is not one.
 *
 * A bare address becomes a single-host rule, because that is what an operator
 * typing `192.168.1.50` means. Host bits are masked off rather than rejected:
 * `192.168.1.14/24` is what someone writes when they copy their own address and
 * widen it, and answering with `192.168.1.0/24` is more useful than an error.
 */
export function parseRule(text: string): AccessRule | null {
  if (ruleProblem(text) !== null) return null;

  const trimmed = text.trim();
  const slash = trimmed.lastIndexOf("/");
  const parsed = parseAddress(slash === -1 ? trimmed : trimmed.slice(0, slash));
  if (!parsed) return null;

  const width = parsed.family === 4 ? 32 : 128;
  const bits = slash === -1 ? width : Number(trimmed.slice(slash + 1));
  const bytes = maskBytes(parsed.bytes, bits);
  const address = parsed.family === 4 ? formatIpv4(bytes) : formatIpv6(bytes);

  return { text: `${address}/${bits}`, family: parsed.family, bytes, bits };
}

/** Parse a stored list, dropping anything unusable. */
export function compileRules(texts: readonly string[]): AccessRule[] {
  const rules: AccessRule[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    const rule = parseRule(text);
    if (!rule || seen.has(rule.text)) continue;
    seen.add(rule.text);
    rules.push(rule);
  }

  return rules;
}

function prefixMatches(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;

  const remainder = bits & 7;
  if (remainder === 0) return true;

  const mask = (0xff << (8 - remainder)) & 0xff;
  return (a[whole] & mask) === (b[whole] & mask);
}

/**
 * The host the panel runs on.
 *
 * Always allowed, and not listable: the panel's own health check hits
 * `http://127.0.0.1:<port>`, the backup dumpers connect over loopback, and so
 * does every `psql` run on the box. A restriction that could switch those off
 * would be a way to break a machine from a checkbox.
 */
export function isLoopback(parsed: ParsedAddress): boolean {
  if (parsed.family === 4) return parsed.bytes[0] === 127;

  for (let i = 0; i < 15; i++) if (parsed.bytes[i] !== 0) return false;
  return parsed.bytes[15] === 1;
}

/**
 * Does this source get through?
 *
 * An address that will not parse is refused. It should not happen — the value
 * comes from a connected socket — but "unrecognised" is not a reason to admit
 * someone.
 */
export function isAllowed(address: string, rules: readonly AccessRule[]): boolean {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  if (isLoopback(parsed)) return true;

  for (const rule of rules) {
    if (rule.family !== parsed.family) continue;
    if (prefixMatches(parsed.bytes, rule.bytes, rule.bits)) return true;
  }

  return false;
}

/* ---------------------------------------------------------------------------
 * The networks this machine sits on, offered as things to tick.
 *
 * Typing a CIDR by hand is exactly where an operator locks themselves out of
 * their own database, so the panel does the arithmetic: it reads the host's
 * interfaces, masks each address with its own netmask, and proposes the
 * resulting networks. The derivation is a function of its input rather than of
 * the host, so a test can assert it against a captured fixture instead of
 * against whatever the machine running it happens to be plugged into.
 * ------------------------------------------------------------------------- */

export type NetworkKind = "lan" | "vpn" | "virtual";

/** The shape of one entry of `os.networkInterfaces()`, restated to avoid the import. */
export interface HostInterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
  cidr?: string | null;
}

export interface SuggestedNetwork {
  /** The rule to store, already canonical: `192.168.1.0/24`. */
  cidr: string;
  /** The interface as the OS names it — `Ethernet`, `eth0`, `docker0`. */
  iface: string;
  /** A recognised name for the range, when there is one. Empty otherwise. */
  label: string;
  kind: NetworkKind;
  /** This machine's own address on that network, so two LANs are tellable apart. */
  address: string;
}

/**
 * Interfaces that carry a tunnel rather than a wire.
 *
 * Worth separating because the answer they enable is different: allowing a VPN
 * range is how you reach a database from outside the building without putting a
 * port on the internet, and it should not read like allowing the office LAN.
 */
const VPN_INTERFACE =
  /^(tailscale|nordlynx|wg\d*|wireguard|tun\d*|utun\d*|ppp\d*|zt[a-z0-9]*|zerotier|proton|mullvad|nordvpn|expressvpn|openvpn|tap\d*)/i;

/** Switches and bridges the host invented: Hyper-V, WSL, Docker, VirtualBox. */
const VIRTUAL_INTERFACE =
  /(vethernet|hyper-?v|default switch|wsl|docker|^br-|^veth|vmnet|vboxnet|virtualbox|vmware|^virbr)/i;

/**
 * Tailscale hands out a /32 and a /128, so masking one of its addresses with
 * its own netmask yields that single host and nothing else — useless as a rule,
 * because the point is to admit the *other* machines on the tailnet. These two
 * ranges are the tailnet, and recognising them turns that dead end into the
 * suggestion the operator wanted.
 */
const TAILNET_V4 = "100.64.0.0/10";
const TAILNET_V6 = "fd7a:115c:a1e0::/48";

function inTailnetV4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts[0] !== "100") return false;
  const second = Number(parts[1]);
  return second >= 64 && second <= 127;
}

function inTailnetV6(address: string): boolean {
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function classify(iface: string): NetworkKind {
  // VPN first: Windows names adapters like `vEthernet (Tailscale)`, which would
  // otherwise be read as plumbing.
  if (VPN_INTERFACE.test(iface)) return "vpn";
  if (VIRTUAL_INTERFACE.test(iface)) return "virtual";
  return "lan";
}

/** Order the list the way it gets read: the LAN first, tunnels next, plumbing last. */
const KIND_ORDER: Record<NetworkKind, number> = { lan: 0, vpn: 1, virtual: 2 };

/**
 * Turn a host's interfaces into networks worth offering.
 *
 * Dropped on the way through:
 *   - loopback, which is allowed unconditionally and is not the operator's to
 *     switch off;
 *   - link-local (`169.254/16`, `fe80::/10`), which is what an interface uses
 *     when it has no address — an allowlist entry for it means nothing;
 *   - anything whose netmask leaves no network to speak of (a /32 or /128 that
 *     is not a recognised tunnel), since suggesting a single host that happens
 *     to be *this* host helps nobody.
 *
 * Docker needs no special case: its bridges are ordinary interfaces here —
 * `docker0` on Linux, `br-<id>` per user-defined network, `vEthernet (…)` under
 * Docker Desktop — and they land in `virtual`.
 */
export function networksFrom(
  interfaces: Record<string, HostInterfaceAddress[] | undefined>
): SuggestedNetwork[] {
  const found = new Map<string, SuggestedNetwork>();

  for (const [iface, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;

      const isV6 = entry.family === "IPv6" || entry.family === 6;
      const address = entry.address.split("%")[0];

      if (!isV6 && address.startsWith("169.254.")) continue;
      if (isV6 && /^fe[89ab]/i.test(address)) continue;

      let cidr: string;
      let label = "";

      if (!isV6 && inTailnetV4(address)) {
        cidr = TAILNET_V4;
        label = "Tailnet";
      } else if (isV6 && inTailnetV6(address)) {
        cidr = TAILNET_V6;
        label = "Tailnet";
      } else {
        // `entry.cidr` is address + prefix; masking the host bits off is the
        // whole derivation, and `parseRule` is already the thing that does it.
        const rule = entry.cidr ? parseRule(entry.cidr) : null;
        if (!rule) continue;
        if (rule.bits === (isV6 ? 128 : 32)) continue;
        cidr = rule.text;
      }

      if (found.has(cidr)) continue;
      found.set(cidr, { cidr, iface, label, kind: classify(iface), address });
    }
  }

  return [...found.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.iface.localeCompare(b.iface)
  );
}
