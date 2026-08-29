[← RunPanel](../../README.md) · **Italiano** · [English](../en/network.md)

---

# Accesso di rete

Di default RunPanel pubblica una porta come fa Docker — `-p 5433:5432`, senza
indirizzo di bind, su tutte le interfacce. È comodo, e vuol dire che un database
creato dal pannello risponde a tutto ciò che sta sulla LAN, e a internet se la
macchina ha un indirizzo pubblico.

Accendendo **Chi può collegarsi**, su un servizio o su un progetto, cambia così:

- il container viene ricreato (o l'app riavviata) pubblicando su `127.0.0.1` e su
  una porta che il pannello alloca;
- il pannello occupa la porta che i tuoi client già conoscono, e inoltra solo le
  connessioni dagli indirizzi che hai elencato;
- `127.0.0.1` e `::1` sono sempre consentiti e non si possono togliere: da lì
  arrivano la sonda di health check, i dumper dei backup e qualsiasi `psql` sulla
  macchina.

Le regole sono singoli indirizzi o intervalli CIDR, IPv4 o IPv6. Il pannello
legge le interfacce della macchina e le propone come caselle da spuntare,
etichettate: la LAN, gli intervalli VPN (la `100.64.0.0/10` di Tailscale è
riconosciuta), e gli switch virtuali. Chi viene respinto compare nella pagina con
un pulsante **Consenti**.

Due cose da sapere prima di accenderlo:

- **Fallisce in chiusura.** La porta è tenuta aperta dal processo del pannello:
  se il pannello non gira, la porta è chiusa. Prima il database di un'app restava
  raggiungibile anche a pannello spento.
- **Un'app sulla rete del progetto non è toccata.** Raggiunge il proprio database
  per nome del container su `runpanel-net-<slug>`, che non passa mai dal gate. Ci
  passa invece il traffico che arriva da `host.docker.internal`.

Non viene offerto per un progetto **Compose**, che pubblica le porte da un file
che RunPanel non riscrive, né per un container su `network: host`, che non ha una
porta pubblicata da spostare. In entrambi i casi lo dice.

Per un processo nativo il pannello passa anche `HOST`/`HOSTNAME` e, per le CLI di
cui conosce la sintassi, il flag di bind. Un'app che ignora tutto questo resta su
tutte le interfacce alla porta spostata, quindi il pannello lo verifica e lo
scrive nella pagina.
