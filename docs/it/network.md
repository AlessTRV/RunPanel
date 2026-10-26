[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/network.md)

---

# Accesso di rete

Di default RunPanel pubblica una porta come fa Docker, `-p 5433:5432`, su tutte le interfacce: un database creato dal pannello risponde a tutta la LAN, e a internet se la macchina ha un indirizzo pubblico.

Nella sezione **Chi può collegarsi** di un servizio o di un progetto, l'interruttore **Limita** cambia le cose così (per un database si può scegliere già alla creazione):

- il container viene ricreato, o l'app riavviata, pubblicando solo su `127.0.0.1` e su una porta che il pannello sceglie;
- il pannello occupa la porta che i tuoi client già conoscono e inoltra solo le connessioni dagli indirizzi elencati;
- la macchina stessa (`127.0.0.0/8` e `::1`) è sempre consentita e non si può togliere: da lì arrivano health check, backup e qualsiasi `psql` locale.

Accendendo **Limita**, le reti della macchina sono già spuntate. Una lista vuota vuol dire "solo questa macchina".

## Le regole

Sono indirizzi singoli o intervalli CIDR, IPv4 o IPv6. Il pannello propone come caselle le reti delle interfacce della macchina, etichettate: LAN, VPN (Tailscale è riconosciuta, sia `100.64.0.0/10` sia `fd7a:115c:a1e0::/48`) e switch virtuali. Con un [reverse proxy configurato](configuration.md#metterlo-su-internet) propone anche **Il tuo indirizzo ora**.

Un intervallo `/0` è rifiutato, i bit dell'host vengono azzerati (`192.168.1.14/24` diventa `192.168.1.0/24`) e un IPv4 con zeri iniziali non è accettato. Modificare le regole vale per le connessioni nuove; quelle aperte restano.

Le connessioni respinte compaiono sotto **Rifiutati di recente** (le ultime cinque) con un pulsante **Consenti**. Il pannello le ricorda in memoria, al massimo venti per porta, e le dimentica a ogni riavvio.

## Prima di accenderlo

- **Fallisce in chiusura.** La porta è tenuta aperta dal processo del pannello: se il pannello non gira, o gira con `RUNPANEL_DISABLE_SCHEDULERS`, la porta è chiusa. Una regola che deve valere anche a pannello spento ha bisogno anche di un firewall sulla macchina.
- **La rete del progetto non è toccata.** Un progetto Docker o Compose raggiunge il proprio database per nome sulla rete `runpanel-net-<slug>` (vedi [Database](databases.md)), che non passa dal gate. Ci passa invece il traffico da `host.docker.internal`.
- **Un sottodominio segue le stesse regole.** nginx raggiunge l'app in loopback, che il gate lascia sempre passare, quindi applica la lista da sé: il [sottodominio](domains.md) di un progetto fa entrare gli indirizzi della lista e questa macchina, a meno che il nome non sia aperto a tutti esplicitamente.

Non è disponibile per un progetto **Compose** (pubblica le porte da un file che RunPanel non riscrive), per un container su `network: host` e per un progetto senza porta. La pagina lo dice.

Per un processo nativo il pannello imposta `HOST`/`HOSTNAME` e, per le CLI di cui conosce la sintassi, il flag di bind, a meno che il comando di avvio contenga già `-p` o `--port`. Un'app che ignora tutto questo resta raggiungibile alla porta spostata su tutte le interfacce: il pannello lo verifica e lo segnala nella pagina.
