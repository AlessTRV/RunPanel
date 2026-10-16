[← RunPanel](../../README.md) · [Italiano](../it/network.md) · **English**

---

# Network access

By default RunPanel publishes a port the way Docker does, `-p 5433:5432`, on every interface: a database created by the panel answers the whole LAN, and the internet if the machine has a public address.

In the **Chi può collegarsi** (who can connect) section of a service or project, the **Limita** switch changes that (for a database it can be chosen at creation already):

- the container is recreated, or the app restarted, publishing only on `127.0.0.1` and on a port the panel picks;
- the panel holds the port your clients already know and forwards only connections from the listed addresses;
- the machine itself (`127.0.0.0/8` and `::1`) is always allowed and cannot be removed: health checks, backups and any local `psql` come from there.

When **Limita** is turned on, the machine's networks come pre-ticked. An empty list means "this machine only".

## The rules

Rules are single addresses or CIDR ranges, IPv4 or IPv6. The panel offers the networks of the machine's interfaces as labelled tick boxes: LAN, VPN (Tailscale is recognised, both `100.64.0.0/10` and `fd7a:115c:a1e0::/48`) and virtual switches. With a [reverse proxy configured](configuration.md#putting-it-on-the-internet) it also offers **Il tuo indirizzo ora** (your address now).

A `/0` range is refused, host bits are masked (`192.168.1.14/24` becomes `192.168.1.0/24`) and an IPv4 address with leading zeros is rejected. Editing the rules applies to new connections; open ones stay.

Refused connections appear under **Rifiutati di recente** (the last five) with a **Consenti** button. The panel keeps them in memory, at most twenty per port, and forgets them on every restart.

## Before turning it on

- **It fails closed.** The port is held open by the panel's process: if the panel is not running, or runs with `RUNPANEL_DISABLE_SCHEDULERS`, the port is closed. A rule that must hold with the panel down needs a host firewall as well.
- **The project network is untouched.** A Docker or Compose project reaches its own database by name on the `runpanel-net-<slug>` network (see [Databases](databases.md)), which does not go through the gate. Traffic from `host.docker.internal` does.

It is not available for a **Compose** project (its ports come from a file RunPanel does not rewrite), for a container on `network: host`, or for a project without a port. The page says so.

For a native process the panel sets `HOST`/`HOSTNAME` and, for the CLIs whose syntax it knows, the bind flag, unless the start command already contains `-p` or `--port`. An app that ignores all of this stays reachable on the moved port on every interface: the panel checks and says so on the page.
