import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Who a rule lets through.
 *
 * This is the decision the access gate makes on every accepted socket, and it
 * is the one place where getting it wrong is silent in both directions: too
 * loose and a port the operator believes is closed is open, too strict and they
 * are locked out of their own database with no error to read.
 *
 * Standalone: no server, no daemon, no network. `lib/ip-access.ts` has zero
 * imports precisely so this suite can load it anywhere.
 */
export const meta = { name: "access-rules-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("access-rules-unit");
  const { normalizeAddress, parseRule, compileRules, isAllowed, ruleProblem, networksFrom } =
    await import(pathToFileURL(join(repoRoot, "lib", "ip-access.ts")).href);
  const { readAccess, publishArg, listenPort, isRestricted } = await import(
    pathToFileURL(join(repoRoot, "lib", "access-columns.ts")).href
  );

  const allow = (address, ...rules) => isAllowed(address, compileRules(rules));

  // --- address normalisation -------------------------------------------------
  {
    // The form a dual-stack listener actually reports for an IPv4 peer. Every
    // rule an operator writes is IPv4, so failing to fold this would reject
    // everyone while the allowlist looked correct.
    r.check(
      "IPv4-mapped IPv6 folds back to IPv4",
      normalizeAddress("::ffff:192.168.1.14") === "192.168.1.14",
      String(normalizeAddress("::ffff:192.168.1.14"))
    );

    r.check("brackets are stripped", normalizeAddress("[::1]") === "::1", String(normalizeAddress("[::1]")));

    // The zone identifies an interface on this host, not the peer.
    r.check(
      "zone identifier is dropped",
      normalizeAddress("fe80::1%eth0") === "fe80::1",
      String(normalizeAddress("fe80::1%eth0"))
    );

    r.check(
      "IPv6 is canonicalised",
      normalizeAddress("FD7A:115C:A1E0:0:0:0:FF01:795B") === "fd7a:115c:a1e0::ff01:795b",
      String(normalizeAddress("FD7A:115C:A1E0:0:0:0:FF01:795B"))
    );

    // `010.0.0.1` is 8.0.0.1 to a C resolver and 10.0.0.1 to a naive one. An
    // allowlist that disagrees with the kernel about who it admitted is worse
    // than one that refuses the input.
    r.check("leading zeros are refused", normalizeAddress("010.0.0.1") === null);
    r.check("out-of-range octet is refused", normalizeAddress("256.1.1.1") === null);
    r.check("nine groups are refused", normalizeAddress("1:2:3:4:5:6:7:8:9") === null);
    r.check("two :: runs are refused", normalizeAddress("1::2::3") === null);
    r.check("empty string is refused", normalizeAddress("") === null);
  }

  // --- rule parsing ----------------------------------------------------------
  {
    // What someone writes when they copy their own address and widen it. An
    // error here would be technically defensible and practically useless.
    r.check(
      "host bits are masked off",
      parseRule("192.168.1.14/24")?.text === "192.168.1.0/24",
      String(parseRule("192.168.1.14/24")?.text)
    );

    r.check(
      "a bare address is a single host",
      parseRule("192.168.1.50")?.text === "192.168.1.50/32",
      String(parseRule("192.168.1.50")?.text)
    );

    r.check(
      "a bare IPv6 address is a /128",
      parseRule("fd7a:115c:a1e0::ff01:795b")?.text === "fd7a:115c:a1e0::ff01:795b/128",
      String(parseRule("fd7a:115c:a1e0::ff01:795b")?.text)
    );

    r.check(
      "an IPv6 prefix keeps its canonical form",
      parseRule("fd7a:115c:a1e0::/48")?.text === "fd7a:115c:a1e0::/48",
      String(parseRule("fd7a:115c:a1e0::/48")?.text)
    );

    // /0 is a valid prefix that means "everyone". Accepting it would let the
    // panel print "1 rete consentita" over a port open to the internet.
    r.check("a /0 rule is rejected", parseRule("0.0.0.0/0") === null);
    r.check("and says why", ruleProblem("0.0.0.0/0") === "everything", String(ruleProblem("0.0.0.0/0")));
    r.check("as does ::/0", ruleProblem("::/0") === "everything", String(ruleProblem("::/0")));

    r.check("prefix wider than the family is rejected", parseRule("192.168.1.0/33") === null);
    r.check("a non-numeric prefix is rejected", parseRule("192.168.1.0/ab") === null);
    r.check("a valid rule has no problem", ruleProblem("10.0.0.0/8") === null);
    r.check("garbage is a syntax problem", ruleProblem("not-an-address") === "syntax");

    // Duplicates collapse after canonicalisation, so checking a suggestion and
    // then typing the same network by hand cannot list it twice.
    r.check(
      "compileRules drops duplicates and rubbish",
      compileRules(["192.168.1.0/24", "192.168.1.7/24", "nonsense"]).length === 1,
      String(compileRules(["192.168.1.0/24", "192.168.1.7/24", "nonsense"]).length)
    );
  }

  // --- matching --------------------------------------------------------------
  {
    r.check("a host inside the LAN passes", allow("192.168.1.99", "192.168.1.0/24"));
    r.check("a host outside it does not", !allow("192.168.2.99", "192.168.1.0/24"));
    r.check("an exact host rule passes", allow("10.5.0.2", "10.5.0.2"));
    r.check("a neighbour of an exact rule does not", !allow("10.5.0.3", "10.5.0.2"));
    r.check("a /16 covers its range", allow("10.5.240.9", "10.5.0.0/16"));

    // A /10 is the case a byte-wise comparison gets wrong: the prefix ends in
    // the middle of the second octet, and Tailscale's whole range is one.
    r.check("a Tailnet address matches the CGNAT range", allow("100.123.121.81", "100.64.0.0/10"));
    r.check("100.128.x is outside it", !allow("100.128.0.1", "100.64.0.0/10"));
    r.check("100.63.x is outside it", !allow("100.63.255.255", "100.64.0.0/10"));

    // The mapped form has to match an IPv4 rule, or a dual-stack listener
    // rejects every IPv4 client on a correct allowlist.
    r.check("a mapped IPv4 peer matches an IPv4 rule", allow("::ffff:192.168.1.5", "192.168.1.0/24"));

    r.check("an IPv6 prefix matches", allow("fd7a:115c:a1e0::ff01:795b", "fd7a:115c:a1e0::/48"));
    r.check("a neighbouring IPv6 prefix does not", !allow("fd7b:115c:a1e0::1", "fd7a:115c:a1e0::/48"));

    // Families do not cross: an IPv4 rule must never admit an IPv6 peer.
    r.check("an IPv6 peer does not match an IPv4 rule", !allow("fd7a::1", "0.0.0.0/8", "192.168.1.0/24"));
    r.check("an IPv4 peer does not match an IPv6 rule", !allow("192.168.1.5", "fd00::/8"));

    r.check("any of several rules is enough", allow("10.5.0.2", "192.168.1.0/24", "10.5.0.0/16"));
  }

  // --- loopback and the empty list ------------------------------------------
  {
    // Not listable and not removable: the panel's own health check, the backup
    // dumpers and every psql on the box come from here. A restriction that
    // could switch those off would break a machine from a checkbox.
    r.check("loopback passes an empty list", allow("127.0.0.1"));
    r.check("the whole 127/8 passes", allow("127.0.0.53"));
    r.check("IPv6 loopback passes", allow("::1"));
    r.check("a mapped loopback passes", allow("::ffff:127.0.0.1"));

    // An empty list under restriction means "only this machine", which is the
    // state a target lands in the moment the switch goes on.
    r.check("an empty list admits nobody else", !allow("192.168.1.5"));

    // Should not happen — the value comes off a connected socket — but
    // unrecognised is not a reason to let someone in.
    r.check("an unparseable source is refused", !allow("who-is-this", "0.0.0.0/1"));
  }

  // --- suggested networks, Windows -------------------------------------------
  {
    // Captured verbatim from a real Windows host, because the interesting cases
    // are the ones a synthetic fixture would not think to include: a VPN that
    // reports a /32, a Hyper-V switch, and link-local addresses on every card.
    const windows = {
      Tailscale: [
        { address: "fd7a:115c:a1e0::ff01:795b", family: "IPv6", internal: false, cidr: "fd7a:115c:a1e0::ff01:795b/128" },
        { address: "fe80::9a7f:e6bd:ae5f:9da0", family: "IPv6", internal: false, cidr: "fe80::9a7f:e6bd:ae5f:9da0/64" },
        { address: "100.123.121.81", family: "IPv4", internal: false, cidr: "100.123.121.81/32" },
      ],
      NordLynx: [
        { address: "fe80::9a7f:e6bd:ae5f:9da0", family: "IPv6", internal: false, cidr: "fe80::9a7f:e6bd:ae5f:9da0/64" },
        { address: "10.5.0.2", family: "IPv4", internal: false, cidr: "10.5.0.2/16" },
      ],
      Ethernet: [
        { address: "fe80::8986:fb39:e2e4:529", family: "IPv6", internal: false, cidr: "fe80::8986:fb39:e2e4:529/64" },
        { address: "192.168.1.14", family: "IPv4", internal: false, cidr: "192.168.1.14/24" },
      ],
      "Loopback Pseudo-Interface 1": [
        { address: "::1", family: "IPv6", internal: true, cidr: "::1/128" },
        { address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" },
      ],
      "vEthernet (Default Switch)": [
        { address: "fe80::b2c5:ae3c:6463:9f71", family: "IPv6", internal: false, cidr: "fe80::b2c5:ae3c:6463:9f71/64" },
        { address: "172.21.224.1", family: "IPv4", internal: false, cidr: "172.21.224.1/20" },
      ],
    };

    const list = networksFrom(windows);
    const byCidr = Object.fromEntries(list.map((n) => [n.cidr, n]));

    r.check("five networks come out of eleven addresses", list.length === 5, String(list.length));

    // The plain derivation: address masked with its own netmask.
    r.check("the LAN is masked to its network", Boolean(byCidr["192.168.1.0/24"]));
    r.check("and is classified as a LAN", byCidr["192.168.1.0/24"]?.kind === "lan");
    r.check(
      "it carries this machine's address so two LANs are tellable apart",
      byCidr["192.168.1.0/24"]?.address === "192.168.1.14"
    );

    // Tailscale's /32 would mask to a single host — itself — which admits
    // nobody. The tailnet range is the suggestion that was actually wanted.
    r.check("a Tailscale /32 becomes the tailnet range", Boolean(byCidr["100.64.0.0/10"]));
    r.check("labelled as such", byCidr["100.64.0.0/10"]?.label === "Tailnet");
    r.check("and classified as VPN", byCidr["100.64.0.0/10"]?.kind === "vpn");
    r.check("its IPv6 /128 gets the same treatment", byCidr["fd7a:115c:a1e0::/48"]?.label === "Tailnet");

    r.check("a VPN with a real netmask keeps it", byCidr["10.5.0.0/16"]?.kind === "vpn");
    r.check("the Hyper-V switch is plumbing", byCidr["172.21.224.0/20"]?.kind === "virtual");

    // An allowlist entry for a link-local address means nothing: it is what a
    // card uses when it has no address.
    r.check("link-local addresses are dropped", !list.some((n) => n.cidr.startsWith("fe80")));
    r.check("loopback is not offered", !list.some((n) => n.cidr.startsWith("127.")));

    // The LAN is what gets ticked; the plumbing is what gets read last.
    r.check("the LAN sorts first", list[0].cidr === "192.168.1.0/24", list[0].cidr);
    r.check("the virtual switch sorts last", list[list.length - 1].kind === "virtual");
  }

  // --- suggested networks, Linux ---------------------------------------------
  {
    // Docker gets no special case: on Linux its bridges are ordinary
    // interfaces, and they have to land in `virtual` on their names alone.
    const linux = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
      eth0: [{ address: "10.0.1.37", family: "IPv4", internal: false, cidr: "10.0.1.37/24" }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false, cidr: "172.17.0.1/16" }],
      "br-9f2c1a4b7e01": [{ address: "172.18.0.1", family: "IPv4", internal: false, cidr: "172.18.0.1/16" }],
      tailscale0: [{ address: "100.99.4.2", family: "IPv4", internal: false, cidr: "100.99.4.2/32" }],
      // No netmask to work with and not a known tunnel: a suggestion here would
      // be this host and nobody else.
      ppp0: [{ address: "198.51.100.7", family: "IPv4", internal: false, cidr: null }],
    };

    const list = networksFrom(linux);
    const byCidr = Object.fromEntries(list.map((n) => [n.cidr, n]));

    r.check("the wire is a LAN", byCidr["10.0.1.0/24"]?.kind === "lan");
    r.check("the docker bridge is plumbing", byCidr["172.17.0.0/16"]?.kind === "virtual");
    r.check("so is a user-defined bridge", byCidr["172.18.0.0/16"]?.kind === "virtual");
    r.check("tailscale0 resolves to the tailnet", byCidr["100.64.0.0/10"]?.kind === "vpn");
    r.check("an address with no netmask is skipped", !list.some((n) => n.address === "198.51.100.7"));
    r.check("four networks in total", list.length === 4, String(list.length));
  }

  // --- the columns, and the publish spec they produce ------------------------
  {
    // Every row predating migration 008, and every row the migration wrote.
    const legacy = { access_mode: null, access_allow: null, access_port: null };
    r.check("a row with no columns is open", readAccess(legacy).mode === "open");
    r.check("with no rules", readAccess(legacy).allow.length === 0);
    r.check("and no moved port", readAccess(legacy).port === null);
    r.check("isRestricted agrees", isRestricted(legacy) === false);

    const restricted = {
      access_mode: "restricted",
      access_allow: '["192.168.1.0/24","10.5.0.0/16"]',
      access_port: 49731,
    };
    r.check("a restricted row reads back", readAccess(restricted).allow.length === 2);
    r.check("with its moved port", readAccess(restricted).port === 49731);

    // A restored archive or a hand-edited store can hold anything. Unreadable
    // has to mean "no rules", never "restricted with rules I invented".
    const rubbish = { access_mode: "restricted", access_allow: "{not json", access_port: 49731 };
    r.check("an unreadable list is an empty one", readAccess(rubbish).allow.length === 0);
    r.check("and the row stays restricted", readAccess(rubbish).mode === "restricted");

    const mixed = { access_mode: "restricted", access_allow: '["10.0.0.0/8",7,null]', access_port: 1 };
    r.check("non-strings are dropped from the list", readAccess(mixed).allow.length === 1);

    // An unrecognised mode is open, which is what the port already was.
    // Treating it as restricted would turn a bad string into an outage.
    r.check("an unknown mode is open", readAccess({ ...legacy, access_mode: "sideways" }).mode === "open");

    // The line that decides whether a database is on the internet.
    r.check(
      "an open row publishes on every interface, as it always did",
      publishArg(legacy, 5433, 5432) === "5433:5432",
      publishArg(legacy, 5433, 5432)
    );
    r.check(
      "a restricted row publishes on loopback and the moved port",
      publishArg(restricted, 5433, 5432) === "127.0.0.1:49731:5432",
      publishArg(restricted, 5433, 5432)
    );

    // Cannot arrive through the API; if it ever does, do what the row says
    // rather than invent a binding for it.
    r.check(
      "restricted with no port falls back to open",
      publishArg({ ...restricted, access_port: null }, 5433, 5432) === "5433:5432"
    );

    r.check("an open target listens on its published port", listenPort(legacy, 3000) === 3000);
    r.check("a restricted one listens on the moved port", listenPort(restricted, 3000) === 49731);
  }

  return r.result();
}
