<div align="center">

<img src=".github/assets/logo.png" alt="RunPanel" width="88" height="88">

# RunPanel

**Il tuo server, i tuoi deploy.** Un pannello self-hosted che distribuisce da GitHub, da uno ZIP
o da un Dockerfile, con il build in diretta, database su richiesta e backup che si ripristinano davvero.

**Italiano** · [English](README.en.md)

[![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=next.js)](https://nextjs.org) [![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Node.js](https://img.shields.io/badge/Node.js-20+-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) [![Docker](https://img.shields.io/badge/Docker-runtime-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com) [![PM2](https://img.shields.io/badge/PM2-runtime-2B037A?style=flat-square&logo=pm2&logoColor=white)](https://pm2.keymetrics.io) [![SQLite](https://img.shields.io/badge/SQLite-store-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org) [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-store-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org) [![License](https://img.shields.io/badge/License-MIT-3B82F6?style=flat-square)](#licenza)

[Avvio rapido](#-avvio-rapido) · [Funzionalità](#-cosa-fa) · [Schermate](#-il-pannello) · [Documentazione](#-documentazione) · [Sicurezza](#-sicurezza)

<br>

<img src=".github/assets/overview.png" alt="Panoramica di RunPanel: avvisi, risorse dell'host e progetti raggruppati in cartelle" width="100%">

</div>

<br>

## ✨ Cosa fa

<table>
<tr>
<td width="50%" valign="top">

### 🚀 Distribuisce qualsiasi cosa
Node.js, siti statici, Docker, Compose, o un runtime personalizzato con i tuoi comandi. Un repository può dichiarare il proprio contratto di deploy in `runpanel.json`.

</td>
<td width="50%" valign="top">

### 📡 Deploy in diretta
L'output del build arriva al browser mentre il deploy gira, su una sola connessione SSE per progetto.

</td>
</tr>
<tr>
<td valign="top">

### ⏪ Torna a una versione precedente
Scegli un commit qualsiasi dalla cronologia del branch e distribuisci quello. Il progetto ci resta fermo, e l'auto-deploy viene sospeso invece di riportarlo avanti in silenzio.

</td>
<td valign="top">

### 🗄️ Database su richiesta
PostgreSQL, MySQL, Redis e MongoDB creati come container etichettati con i propri volumi. La connection URL arriva nell'app solo con un interruttore esplicito.

</td>
</tr>
<tr>
<td valign="top">

### 💾 Backup che si ripristinano
Dump programmati dei database, dello store del pannello, della configurazione e dei volumi dei progetti, in un unico zip verificabile, su disco locale o su un bucket S3-compatibile.

</td>
<td valign="top">

### 👥 Utenti e permessi
Più account, inviti con link a scadenza, livelli Lettura / Operatore / Gestione su cartelle, progetti e servizi, e un registro di chi ha fatto cosa.

</td>
</tr>
<tr>
<td valign="top">

### 🔁 Torna su dopo un riavvio
Genera e installa la unit systemd (o una riga cron `@reboot`), controlla che Docker parta all'avvio e rimette su progetti e servizi nell'ordine che hai scelto.

</td>
<td valign="top">

### 🛡️ Porte limitate alle reti che indichi
Qualunque database o app può essere ristretto a indirizzi specifici, con le reti della macchina proposte come caselle da spuntare.

</td>
</tr>
<tr>
<td valign="top">

### 🧹 Manutenzione di Docker
Retention delle immagini per progetto, rilevamento degli orfani e pulizia dei volumi che chiede prima di distruggere dati.

</td>
<td valign="top">

### 🩺 Diagnostica
Una pagina che dice cosa non va in questa installazione e cosa premere per sistemarlo.

</td>
</tr>
</table>

## 📺 Deploy in diretta

Premi **Deploy** e il log del build scorre nel browser mentre succede: installazione, build, avvio, health check. Quando il processo risponde, il badge passa a *In esecuzione*.

<div align="center">
<img src=".github/assets/deploy-live.gif" alt="Un deploy di RunPanel: il log del build scorre in diretta e il progetto passa a In esecuzione" width="100%">
</div>

## 💻 Il pannello

<table>
<tr>
<td width="50%" valign="top">
<img src=".github/assets/projects.png" alt="Elenco dei progetti">
<p align="center"><b>Progetti</b>: stato, runtime, porta e ultimo deploy</p>
</td>
<td width="50%" valign="top">
<img src=".github/assets/project-detail.png" alt="Dettaglio di un progetto">
<p align="center"><b>Dettaglio progetto</b>: risorse, log, deploy, variabili, file</p>
</td>
</tr>
<tr>
<td valign="top">
<img src=".github/assets/services.png" alt="Servizi gestiti">
<p align="center"><b>Servizi</b>: database gestiti e collegamenti ai progetti</p>
</td>
<td valign="top">
<img src=".github/assets/backups.png" alt="Backup">
<p align="center"><b>Backup</b>: pianificazioni, destinazioni, cronologia</p>
</td>
</tr>
<tr>
<td valign="top">
<img src=".github/assets/monitor.png" alt="Monitor">
<p align="center"><b>Monitor</b>: CPU, memoria e uptime di ogni processo</p>
</td>
<td valign="top">
<img src=".github/assets/user-detail.png" alt="Permessi di un utente">
<p align="center"><b>Accessi</b>: livelli per cartella, progetto e servizio</p>
</td>
</tr>
</table>

<details>
<summary><b>Le sette voci del menu</b></summary>
<br>

Sistema, Accessi e Impostazioni raggruppano più pagine in schede, ognuna con il suo indirizzo.

| Voce | A cosa serve |
|---|---|
| **Panoramica** | stato di tutto, in una schermata: cartelle per raggruppare progetti e servizi, più i servizi senza progetto |
| **Progetti** | deploy, log in diretta, storico, variabili, file, terminale, impostazioni |
| **Servizi** | database gestiti, i loro database interni, collegamenti ai progetti |
| **Backup** | policy, destinazioni, esecuzioni, archivi, ripristini |
| **Monitor** | processi e container con CPU, memoria e uptime, più il riepilogo dell'host |
| **Sistema** | *Diagnostica* (cosa manca e cosa premere), *Avvio automatico* (cosa torna su dopo un riavvio), *Aggiornamenti* (versione, commit nuovi, il pulsante che li applica), *Pulizia Docker* (cosa occupa il disco e cosa si recupera) |
| **Accessi** | *Utenti* (inviti con link a scadenza, permessi per account) e *Registro attività* (chi ha fatto cosa) |
| **Impostazioni** | *Account* (email, password, sessioni, tema chiaro o scuro), *Pannello* (fuso, indirizzo pubblico, polling, colore d'accento, notifiche Telegram, registry), *GitHub* (token, repository, branch) |

</details>

<details>
<summary><b>Dettagli che tornano utili</b></summary>
<br>

- **Terminale**: una shell vera sulla cartella del progetto o dentro il suo container, con le sessioni inattive raccolte automaticamente.
- **File**: un browser confinato alla cartella del progetto, che risolve i symlink prima di aprire qualsiasi cosa.
- **Log**: in diretta via SSE mentre il deploy gira, e su file dopo.
- **Sessioni**: una per dispositivo, revocabili singolarmente dall'account.
- **Preferenze**: intervallo di aggiornamento (2, 5, 10 secondi), fuso orario, cinque colori d'accento (blu predefinito).
- **Tema**: chiaro, scuro o quello del sistema, scelto per browser.
- **Palette comandi** e navigazione da tastiera; su mobile una barra in basso e il menu che entra da destra.

</details>

## ⚡ Avvio rapido

| Requisito | |
|---|---|
| **Node.js** | 20 o superiore |
| **Docker** | per i runtime a container, i database creati dal pannello e i loro backup |
| **PM2** | per i progetti con runtime nativo (`node`, `static`, `custom`): `npm i -g pm2` |

```bash
git clone https://github.com/AlessTRV/RunPanel.git
cd RunPanel
npm install
npm run build
npm start
```

Apri `http://localhost:3000`. Alla prima visita crei l'account **proprietario** con email e password, insieme al **token di setup** che il pannello scrive nel proprio log all'avvio:

```
[RunPanel] Not set up yet. Enter this token on the setup screen:

    3f9c1a...
```

> [!IMPORTANT]
> Finché non esiste una password quell'endpoint deve restare aperto: il token impedisce a chi trova la porta per primo di prendersi il pannello, e qui un amministratore ha una shell sull'host. A ogni riavvio ne viene emesso uno nuovo, a meno che non lo fissi con `RUNPANEL_SETUP_TOKEN`.

PM2 **non** è incluso: senza, resti sui runtime Docker, e la pagina Diagnostica ti dice cosa manca. Il pannello gira su Linux, macOS e Windows; l'installazione automatica all'avvio è solo per Linux.

## ⚙️ Configurazione

Tutto sta in `.env` (vedi `.env.example` per la versione commentata). L'ambiente viene validato all'avvio: un errore fallisce subito con un messaggio, invece che alla prima richiesta che ne ha bisogno.

| Variabile | Default | Cosa fa |
|---|---|---|
| `RUNPANEL_SECRET` | generata in `data/.secret` | Chiave di cifratura, esadecimale, ≥64 caratteri |
| `RUNPANEL_DATA_DIR` | `./data` | Store, repository, log, archivi |
| `PORT` | `3000` | Porta del pannello |
| `RUNPANEL_DB_DRIVER` | `sqlite` | `sqlite` o `postgres` |
| `RUNPANEL_DATABASE_URL` | — | Solo con `postgres` |
| `RUNPANEL_TRUSTED_PROXY_HOPS` | `0` | Quanti reverse proxy stanno davanti |

> [!NOTE]
> Nessuna delle variabili `RUNPANEL_*` raggiunge i progetti che distribuisci: vengono rimosse dall'ambiente dei processi figli, perché `RUNPANEL_SECRET` è la chiave con cui sono cifrati i segreti dei progetti stessi.

Le altre variabili, la scelta fra SQLite e Postgres e cosa serve dietro un reverse proxy stanno in [Configurazione](docs/it/configuration.md).

## 📚 Documentazione

<table>
<tr>
<td width="33%" valign="top">

**[⚙️ Configurazione](docs/it/configuration.md)**<br>
<sub>Variabili d'ambiente, store SQLite o Postgres, registri privati, metterlo su internet</sub>

</td>
<td width="33%" valign="top">

**[🚀 Distribuire un progetto](docs/it/deploy.md)**<br>
<sub>Sorgenti, runtime e preset, il contratto di deploy e `runpanel.json`, variabili, com'è fatto un deploy</sub>

</td>
<td width="33%" valign="top">

**[🔄 Automazione dei deploy](docs/it/automation.md)**<br>
<sub>Webhook, controllo periodico quando il pannello non è raggiungibile, ritorno a un commit, comandi una tantum</sub>

</td>
</tr>
<tr>
<td valign="top">

**[🗄️ Database e servizi](docs/it/databases.md)**<br>
<sub>Motori gestiti, console, cartelle condivise con l'host, collegamento a un progetto</sub>

</td>
<td valign="top">

**[🛡️ Accesso di rete](docs/it/network.md)**<br>
<sub>Limitare una porta agli indirizzi che indichi</sub>

</td>
<td valign="top">

**[💾 Backup e ripristino](docs/it/backups.md)**<br>
<sub>Cosa si salva, come viene preso, dove finisce, come si rimette a posto</sub>

</td>
</tr>
<tr>
<td valign="top">

**[👥 Utenti e permessi](docs/it/users.md)**<br>
<sub>Account, inviti, livelli su progetti e servizi, permessi del pannello, registro attività</sub>

</td>
<td valign="top">

**[🔧 Operatività](docs/it/operations.md)**<br>
<sub>Avvio automatico, aggiornamento del pannello, notifiche su Telegram</sub>

</td>
<td valign="top">

**[🧭 Architettura e sviluppo](docs/it/architecture.md)**<br>
<sub>Mappa del codice, suite di test, come lavorarci</sub>

</td>
</tr>
</table>

## 🔒 Sicurezza

<details open>
<summary><b>Come è protetto il pannello</b></summary>
<br>

- Password con hash bcrypt; le sessioni sono per dispositivo e memorizzate come SHA-256 del cookie, così una copia del database non può essere riusata
- Il setup iniziale richiede il token stampato all'avvio, così un pannello non ancora reclamato non può esserlo da chi arriva per primo
- Il limite sui tentativi di accesso sopravvive a un riavvio, conta in modo atomico, ed è legato a un indirizzo solo dove un proxy configurato lo garantisce
- Più account con permessi per progetto, servizio, cartella e risorsa, controllati dal server su ogni route e su ogni stream; un test fallisce se una route nuova non dichiara cosa protegge ([Utenti e permessi](docs/it/users.md))
- Ogni route `/api` viene rifiutata senza sessione da `proxy.ts` prima ancora di essere raggiunta, in aggiunta al controllo di ciascun handler
- Variabili d'ambiente dei progetti, credenziali dei servizi e dei registri cifrate a riposo (AES-256-GCM)
- La configurazione di RunPanel non raggiunge mai i progetti distribuiti
- Firme dei webhook verificate con HMAC-SHA256 e confronto a tempo costante
- Le operazioni sui file risolvono i symlink e restano confinate al progetto; gli upload ZIP sono spacchettati in-process, rifiutando voci con traversal e link, con un limite sia sull'archivio sia sul decompresso
- Gli URL dei repository devono essere `https://` pubblici, e il token GitHub è allegato soltanto alle richieste verso GitHub
- I comandi esterni passano sempre da un array di argomenti, mai da una stringa di shell
- Qualunque porta pubblicata può essere limitata a reti indicate, davanti a un ascoltatore spostato su loopback perché non ci sia modo di aggirarla

Per il TLS e i reverse proxy davanti al pannello, vedi [Metterlo su internet](docs/it/configuration.md#metterlo-su-internet).

</details>

## ⚠️ Limiti noti

<details>
<summary><b>Cosa sapere prima di affidargli la produzione</b></summary>
<br>

- I comandi una tantum girano **almeno una volta**, non esattamente una volta: un riavvio del pannello a metà esecuzione rimette il comando in coda.
- Le restrizioni sulle porte sono applicate dal processo del pannello, quindi non sopravvivono al suo arresto: la porta semplicemente si chiude. Un insieme di regole che deve valere anche a pannello spento richiede in più un firewall sull'host.
- Il ripristino dello store **Postgres** di RunPanel è rifiutato dal pannello: l'archivio contiene il dump e il comando `pg_restore` esatto, da eseguire con il pannello fermo.
- Il ripristino non confronta le versioni: un dump preso da una major e ripristinato su un'altra viene accettato e fallisce durante l'esecuzione, con la copia di sicurezza già presa.
- L'installazione automatica all'avvio è **solo per Linux**; altrove il pannello mostra cosa fare a mano.
- Le **notifiche** hanno un solo canale, Telegram, e vanno in una sola chat. Il bot non accetta comandi: il pannello parla, non ascolta.
- L'**aggiornamento del pannello dal pannello** richiede un supervisore che lo rimetta su dopo l'uscita: systemd o lo script `@reboot`. Senza, la nuova versione viene costruita ma lo scambio e il riavvio restano due comandi da dare a mano. In un container e su Windows non è disponibile affatto.

</details>

<br>

<div align="center">

## Licenza

MIT

<sub>[⬆ Torna su](#runpanel)</sub>

</div>
