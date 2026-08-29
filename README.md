# RunPanel

**Italiano** · [English](README.en.md)

Pannello di deploy self-hosted. Distribuisce da GitHub, da uno ZIP o da un
Dockerfile, con l'output del build in diretta, database creati su richiesta e una
manutenzione di Docker che il disco lo libera davvero.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20+-5FA04E?logo=nodedotjs&logoColor=white)

![Docker](https://img.shields.io/badge/Docker-runtime-2496ED?logo=docker&logoColor=white)
![PM2](https://img.shields.io/badge/PM2-runtime-2B037A?logo=pm2&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-store-003B57?logo=sqlite&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-store-4169E1?logo=postgresql&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

---

## Cosa fa

- **Distribuisce qualsiasi cosa** — Node.js, siti statici, Docker, Compose, o un
  runtime personalizzato con i tuoi comandi. Un repository può dichiarare il
  proprio contratto di deploy in `runpanel.json`.
- **Deploy in diretta** — l'output del build arriva al browser mentre il deploy
  gira, su una sola connessione SSE per progetto.
- **Torna a una versione precedente** — scegli un commit qualsiasi dalla
  cronologia del branch e distribuisci quello. Il progetto ci resta fermo, e
  l'auto-deploy viene sospeso invece di riportarlo avanti in silenzio.
- **Database su richiesta** — PostgreSQL, MySQL, Redis e MongoDB creati come
  container etichettati con i propri volumi, e la loro connection URL iniettata
  nell'app tramite un interruttore esplicito.
- **Backup che si ripristinano** — dump programmati dei database, dello store del
  pannello e della configurazione e dei volumi dei progetti, in un unico zip
  verificabile, su disco locale o su un bucket S3-compatibile.
- **Torna su dopo un riavvio** — genera e installa la unit systemd (o una riga
  cron `@reboot`), controlla che Docker stesso parta all'avvio, e rimette su i
  progetti e i servizi che hai indicato, nell'ordine che hai scelto.
- **Limita una porta alle reti che indichi** — qualunque database o app può
  essere ristretto a indirizzi specifici, con le reti della macchina proposte
  come caselle da spuntare.
- **Manutenzione** — retention delle immagini per progetto, rilevamento degli
  orfani, e pulizia dei volumi che chiede prima di distruggere dati.
- **Diagnostica** — una pagina che dice cosa non va in questa installazione e
  cosa premere per sistemarlo.

## Requisiti

| | |
|---|---|
| **Node.js** | 20 o superiore |
| **Docker** | per i runtime a container, i database creati dal pannello e i loro backup |
| **PM2** | per i progetti con runtime nativo (`node`, `static`, `custom`) |

PM2 **non** è incluso: installalo globalmente con `npm i -g pm2`, oppure resta
sui runtime Docker. La pagina Diagnostica ti dice in quale dei due casi sei, e
cosa manca.

Il pannello gira su Linux, macOS e Windows. L'installazione automatica all'avvio
è disponibile solo su Linux; le differenze di piattaforma sono trattate dove
contano — l'avvio dei processi, il rilevamento dei binari, i permessi dei file.

## Avvio rapido

```bash
git clone https://github.com/AlessTRV/RunPanel.git
cd RunPanel
npm install
npm run build
npm start
```

Apri `http://localhost:3000`. Alla prima visita ti viene chiesto di impostare una
password di amministratore, insieme al **token di setup** che il pannello scrive
nel proprio log all'avvio:

```
[RunPanel] Not set up yet. Enter this token on the setup screen:

    3f9c1a...
```

Finché non esiste una password quell'endpoint deve restare aperto: il token è
ciò che impedisce a chi trova la porta per primo di prendersi il pannello, e qui
un amministratore ha una shell sull'host. A ogni riavvio ne viene emesso uno
nuovo, a meno che non lo fissi con `RUNPANEL_SETUP_TOKEN`.

## Configurazione

Tutto sta in `.env` — vedi `.env.example` per la versione commentata.
L'ambiente viene validato all'avvio, così un errore fallisce subito con un
messaggio invece che alla prima richiesta che per caso ne ha bisogno.

| Variabile | Default | Cosa fa |
|---|---|---|
| `RUNPANEL_SECRET` | generata in `data/.secret` | Chiave di cifratura, esadecimale, ≥64 caratteri |
| `RUNPANEL_DATA_DIR` | `./data` | Store, repository, log, archivi |
| `PORT` | `3000` | Porta del pannello |
| `RUNPANEL_DB_DRIVER` | `sqlite` | `sqlite` o `postgres` |
| `RUNPANEL_DATABASE_URL` | — | Solo con `postgres` |
| `RUNPANEL_TRUSTED_PROXY_HOPS` | `0` | Quanti reverse proxy stanno davanti |

> Nessuna delle variabili `RUNPANEL_*` raggiunge i progetti che distribuisci.
> Vengono rimosse dall'ambiente dei processi figli, perché `RUNPANEL_SECRET` è la
> chiave con cui sono cifrati i segreti dei progetti stessi.

Le restanti variabili, la scelta fra SQLite e Postgres e cosa serve dietro un
reverse proxy stanno in [Configurazione](docs/it/configuration.md).

## Documentazione

| | |
|---|---|
| [Configurazione](docs/it/configuration.md) | Variabili d'ambiente, store SQLite o Postgres, registri privati, metterlo su internet |
| [Distribuire un progetto](docs/it/deploy.md) | Sorgenti, runtime e preset, il contratto di deploy e `runpanel.json`, variabili, com'è fatto un deploy |
| [Automazione dei deploy](docs/it/automation.md) | Webhook, controllo periodico quando il pannello non è raggiungibile, ritorno a un commit preciso, comandi una tantum |
| [Database e servizi](docs/it/databases.md) | Motori gestiti, console, cartelle condivise con l'host, collegamento a un progetto |
| [Accesso di rete](docs/it/network.md) | Limitare una porta agli indirizzi che indichi |
| [Backup e ripristino](docs/it/backups.md) | Cosa si salva, come viene preso, dove finisce, come si rimette a posto |
| [Operatività](docs/it/operations.md) | Avvio automatico, aggiornamento del pannello, notifiche su Telegram |
| [Architettura e sviluppo](docs/it/architecture.md) | Mappa del codice, suite di test, come lavorarci |

## Il pannello, giorno per giorno

| Pagina | A cosa serve |
|---|---|
| **Panoramica** | stato di tutto, in una schermata |
| **Progetti** | deploy, log in diretta, storico, variabili, file, terminale, impostazioni |
| **Servizi** | database gestiti, i loro database interni, collegamenti ai progetti |
| **Monitor** | CPU, memoria, carico, uptime dell'host e dei container |
| **Storage** | cosa occupa il disco: immagini, volumi, archivi, repository |
| **Backup** | policy, esecuzioni, archivi, ripristini |
| **Autostart** | cosa torna su dopo un riavvio |
| **Aggiornamenti** | la versione del pannello, i commit nuovi, il pulsante che li applica |
| **Diagnostica** | cosa manca a questa installazione e cosa premere |
| **GitHub** | token, repository, branch |
| **Account** | password, sessioni per dispositivo, notifiche Telegram, preferenze |

Dettagli che tornano utili:

- **Terminale** — una shell vera sulla cartella del progetto o dentro il suo
  container, con le sessioni inattive raccolte automaticamente.
- **File** — un browser confinato alla cartella del progetto, che risolve i
  symlink prima di aprire qualsiasi cosa.
- **Log** — in diretta via SSE mentre il deploy gira, e su file dopo.
- **Sessioni** — una per dispositivo, revocabili singolarmente dall'account.
- **Preferenze** — intervallo di aggiornamento (2, 5, 10 secondi), fuso orario,
  cinque temi di accento.
- **Palette comandi** e navigazione da tastiera; su mobile una barra in basso e
  il menu che entra da destra.

## Sicurezza

- Password con hash bcrypt; le sessioni sono per dispositivo e memorizzate come
  SHA-256 del cookie, così una copia del database non può essere riusata
- Il setup iniziale richiede il token stampato all'avvio, così un pannello non
  ancora reclamato non può esserlo da chi arriva per primo
- Il limite sui tentativi di accesso sopravvive a un riavvio, conta in modo
  atomico, ed è legato a un indirizzo solo dove un proxy configurato lo garantisce
- Ogni route `/api` viene rifiutata senza sessione da `proxy.ts` prima ancora di
  essere raggiunta, in aggiunta al controllo di ciascun handler
- Variabili d'ambiente dei progetti, credenziali dei servizi e dei registri
  cifrate a riposo (AES-256-GCM)
- La configurazione di RunPanel non raggiunge mai i progetti distribuiti
- Firme dei webhook verificate con HMAC-SHA256 e confronto a tempo costante
- Le operazioni sui file risolvono i symlink e restano confinate al progetto; gli
  upload ZIP sono spacchettati in-process, rifiutando voci con traversal e link,
  con un limite sia sull'archivio sia sul decompresso
- Gli URL dei repository devono essere `https://` pubblici, e il token GitHub è
  allegato soltanto alle richieste verso GitHub
- I comandi esterni passano sempre da un array di argomenti, mai da una stringa
  di shell
- Qualunque porta pubblicata può essere limitata a reti indicate, davanti a un
  ascoltatore spostato su loopback perché non ci sia modo di aggirarla

Per il TLS e i reverse proxy davanti al pannello, vedi
[Metterlo su internet](docs/it/configuration.md#metterlo-su-internet).

## Limiti noti

- I comandi una tantum girano **almeno una volta**, non esattamente una volta:
  un riavvio del pannello a metà esecuzione rimette il comando in coda.
- Il **tema chiaro** non è incluso; il livello dei token è strutturato per
  accoglierlo.
- Le restrizioni sulle porte sono applicate dal processo del pannello, quindi non
  sopravvivono al suo arresto — la porta semplicemente si chiude. Un insieme di
  regole che deve valere anche a pannello spento richiede in più un firewall
  sull'host.
- Il ripristino dello store **Postgres** di RunPanel è rifiutato dal pannello:
  l'archivio contiene il dump e il comando `pg_restore` esatto, da eseguire con
  il pannello fermo.
- Il ripristino non confronta le versioni: un dump preso da una major e
  ripristinato su un'altra viene accettato e fallisce durante l'esecuzione, con
  la copia di sicurezza già presa.
- L'installazione automatica all'avvio è **solo per Linux**; altrove il pannello
  mostra cosa fare a mano.
- Le **notifiche** hanno un solo canale, Telegram, e vanno in una sola chat. Il
  bot non accetta comandi: il pannello parla, non ascolta.
- L'**aggiornamento del pannello dal pannello** richiede un supervisore che lo
  rimetta su dopo l'uscita: systemd o lo script `@reboot`. Senza, la nuova
  versione viene costruita ma lo scambio e il riavvio restano due comandi da
  dare a mano. In un container e su Windows non è disponibile affatto.

## Licenza

MIT
