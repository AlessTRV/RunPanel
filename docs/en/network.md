[← RunPanel](../../README.en.md) · [Italiano](../it/network.md) · **English**

---

# Network access

By default RunPanel publishes a port the way Docker does — `-p 5433:5432`, with
no bind address, on every interface. That is convenient and it means a database
created from the panel answers to everything on the LAN, and to the internet if
the host has a public address.

Switching **Chi può collegarsi** on, for a service or a project, changes that:

- the container is recreated (or the app restarted) publishing on `127.0.0.1`
  and on a port the panel allocates;
- the panel binds the port your clients already know, and forwards only
  connections from the addresses you listed;
- `127.0.0.1` and `::1` are always allowed and cannot be removed — the health
  probe, the backup dumpers and any `psql` on the box come from there.

Rules are single addresses or CIDR ranges, IPv4 or IPv6. The panel reads the
host's own interfaces and offers them as tick boxes, labelled: the LAN, VPN
ranges (Tailscale's `100.64.0.0/10` is recognised, since its interface reports a
useless `/32`), and virtual switches. Whoever gets turned away is listed on the
page with an **Consenti** button, because otherwise a refused connection and a
stopped database look identical from the other end.

Two things worth knowing before turning it on:

- **It fails closed.** The port is held open by the panel process. If the panel
  is not running, the port is shut. For a security control that is the right
  direction to fail, but it is a change: an app's database used to stay
  reachable while the panel was down.
- **An app on the project network is unaffected.** It reaches its database by
  container name on `runpanel-net-<slug>`, which never goes through the gate.
  Traffic arriving via `host.docker.internal` does, which is why the virtual
  subnets are among the suggestions.

Not offered where it could not be honest: a **Compose** project publishes ports
from a file you own and RunPanel will not rewrite it, and a container on
`network: host` has no published port to move. Both say so instead of showing a
switch that would do nothing.

For a native process the panel also passes `HOST`/`HOSTNAME` and, for the CLIs
where the spelling is known, the bind flag. An app that ignores all of it stays
on every interface at the moved port — so the panel checks, and says so on the
page rather than showing a restriction that is not one.
