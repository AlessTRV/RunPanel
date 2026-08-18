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

## Indice

[Cosa fa](#cosa-fa) · [Requisiti](#requisiti) · [Avvio rapido](#avvio-rapido) ·
[Configurazione](#configurazione) · [Distribuire un progetto](#distribuire-un-progetto) ·
[Database e servizi](#database-e-servizi) · [Accesso di rete](#accesso-di-rete) ·
[Backup e ripristino](#backup-e-ripristino) · [Avvio automatico](#avvio-automatico) ·
[Aggiornare il pannello](#aggiornare-il-pannello) ·
[Notifiche su Telegram](#notifiche-su-telegram) · [Registri privati](#registri-privati) · [Il pannello, giorno per giorno](#il-pannello-giorno-per-giorno) ·
[Sicurezza](#sicurezza) · [Architettura](#architettura) · [Sviluppo](#sviluppo) ·
[Limiti noti](#limiti-noti)

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
| `RUNPANEL_DB_FILE` | `<data>/runpanel.db` | Solo con `sqlite` |
| `RUNPANEL_DATABASE_URL` | — | Solo con `postgres` |
| `RUNPANEL_PG_HOST` `_PORT` `_USER` `_PASSWORD` `_DATABASE` | — | Alternativa all'URL, a credenziali separate |
| `RUNPANEL_PG_SSL` | `disable` | `disable`, `require`, `no-verify` |
| `RUNPANEL_PG_POOL_MAX` | `10` | Connessioni massime del pool |
| `RUNPANEL_TRUSTED_PROXY_HOPS` | `0` | Quanti reverse proxy stanno davanti — vedi [Metterlo su internet](#metterlo-su-internet) |
| `RUNPANEL_SETUP_TOKEN` | generato a ogni avvio | Fissa il token del primo accesso |
| `RUNPANEL_DISABLE_SCHEDULERS` | spento | Silenzia i timer di fondo **e i gate d'accesso** |
| `RUNPANEL_DEV_ORIGINS` | — | Origini aggiuntive accettate da `next dev` |

> Nessuna delle variabili `RUNPANEL_*` raggiunge i progetti che distribuisci.
> Vengono rimosse dall'ambiente dei processi figli, perché `RUNPANEL_SECRET` è la
> chiave con cui sono cifrati i segreti dei progetti stessi.

### Lo store: SQLite o Postgres

```bash
RUNPANEL_DB_DRIVER=postgres
RUNPANEL_DATABASE_URL=postgresql://user:pass@host:5432/runpanel
```

Lo schema e ogni query sono identici sui due driver — la suite di test gira su
entrambi proprio per tenerli tali. Le migrazioni vengono applicate all'avvio,
prima che la prima richiesta arrivi.

SQLite è il default e va benissimo: è il caso per cui il pannello è progettato.
Postgres serve se lo store deve stare fuori dalla macchina, o se vuoi backup
gestiti dalla tua infrastruttura invece che da qui.

## Distribuire un progetto

### Sorgenti

- **GitHub** — collega un token nella pagina GitHub e scegli il repository da un
  elenco, con i branch caricati dall'API. In alternativa incolla un URL
  `https://` pubblico.
- **Upload ZIP** — per il codice che non sta su GitHub. L'archivio viene
  spacchettato in-process, rifiutando le voci con traversal e i link, con un
  limite sia sull'archivio sia sul decompresso.

### Runtime e preset

| Runtime | Cosa fa | Chi lo esegue |
|---|---|---|
| `node` | Rileva il package manager dal lockfile e usa gli script | PM2 |
| `static` | Serve una cartella di build | PM2 |
| `custom` | Solo i comandi che scrivi tu — qualsiasi linguaggio | PM2 |
| `docker` | Costruisce il Dockerfile del repository | Docker |
| `compose` | Avvia lo stack descritto dal compose file | Docker |

I **preset** sono punti di partenza per una forma di repository comune:
Dockerfile, Next.js server, Vite/SPA statica, Python (uvicorn/gunicorn), Go.
Ognuno porta con sé un runtime e i comandi che gli servono.

- In fase di creazione il pannello ne rileva uno guardando i file del repository,
  e puoi sceglierlo a mano per un repository la cui forma non si vede da fuori.
- In **Impostazioni → Build e avvio** puoi selezionare un preset e premere
  **Applica i comandi**: i tre campi vengono riempiti con i suoi, insieme al
  runtime, che con quei comandi viaggia sempre in coppia. Niente viene scritto
  finché non salvi.

La precedenza, dal basso: il preset rilevato, poi il `runpanel.json` del
repository, poi quello che hai impostato nel pannello.

### Il contratto di deploy

Quello che a RunPanel serve sapere per distribuire un progetto. I campi sono
neutri rispetto al runtime; ogni runtime li traduce a modo suo.

| Campo | Docker | PM2 / nativo |
|---|---|---|
| `buildEnv` | un `--build-arg` per voce | ambiente durante install e build |
| `envFile` | scritto 0600 e montato in sola lettura | scritto nella directory di lavoro |
| `commands.release` | container usa-e-getta prima dell'avvio | comando singolo nella cartella del repo |
| `healthcheck` | sondato da RunPanel dopo l'avvio | identico |
| `runtime.restartPolicy` | `--restart` | `autorestart` di PM2 |
| `runtime.memory` / `cpus` / `shmSize` | limiti del container | `max_memory_restart` dove applicabile |
| `docker.network` / `hostname` / `capAdd` | flag di `docker run` | non applicabile |

#### `runpanel.json`

Un repository può dichiarare come vuole essere distribuito:

```json
{
  "version": 1,
  "commands": { "release": "npx prisma migrate deploy" },
  "envFile": { "enabled": true, "path": "/app/.env" },
  "healthcheck": { "path": "/api/health", "startPeriodSec": 45, "timeoutSec": 120 },
  "runtime": { "restartPolicy": "unless-stopped", "memory": "2g" }
}
```

Dove entrambi indicano un valore vince l'impostazione del pannello: l'operatore
vede la macchina di destinazione, il repository no.

Alcuni campi sono **solo del pannello** e vengono ignorati se arrivano da un
repository: `docker.mounts`, `docker.capAdd`, `docker.network`,
`docker.extraHosts` e `envFile.path`. Il resto del contratto descrive come
costruire e avviare l'app, che è affare del repository; questi descrivono cosa
può raggiungere fuori dal proprio container, che è affare tuo. Scegliere un
runtime Docker è una scelta di isolamento, e un `runpanel.json` non deve poter
consegnare a sé stesso l'host. Quando ci prova, il log del deploy nomina i campi
che ha scartato.

### Variabili d'ambiente

Le variabili del progetto si gestiscono nella scheda **Variabili** e sono cifrate
a riposo. Vengono passate al processo o al container, e — se `envFile` è
attivo — scritte anche in un file che l'app può leggere da sola.

Le variabili con prefisso `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` o `REACT_APP_`
vengono passate anche al **build**, non solo al runtime. I frontend le incorporano
nel bundle client, quindi fornirle solo a runtime spedisce il valore sbagliato —
o fa fallire un Dockerfile che le pretende.

### Deploy automatico

Ogni progetto ha un URL webhook con un segreto proprio. Attivando **Deploy
automatico**, un push sul branch configurato avvia un deploy. Le firme sono
verificate con HMAC-SHA256 e confronto a tempo costante; le consegne, accettate o
rifiutate, restano nello storico con il motivo.

Con un account GitHub collegato il webhook **si registra da solo**: attivare
l'interruttore lo crea sul repository con l'URL, il segreto, il content type
`application/json` e il solo evento `push` già impostati. Nessuno dei quattro è
una scelta — seguono tutti dal progetto — e sbagliarne uno a mano falliva in
silenzio. Spegnere l'auto-deploy lo disattiva senza cancellarlo, così lo storico
delle consegne su GitHub resta.

La sezione mostra anche cosa non va: token assente, repository non riconosciuto,
indirizzo del pannello che GitHub non può raggiungere, webhook disallineato,
ultima consegna rifiutata. Il pulsante **Invia ping** chiede a GitHub una
consegna vera — passa da DNS, firewall, TLS e firma, cioè le parti che si
rompono davvero.

Perché il pannello sappia quale indirizzo scrivere su GitHub, imposta
**Indirizzo pubblico** in Account → Preferenze. Lasciato vuoto viene dedotto
dalla richiesta, il che vale finché apri il pannello dallo stesso indirizzo da
cui lo raggiunge GitHub.

> **Pannello raggiungibile solo via VPN o Tailscale?** Allora i webhook non
> arrivano: GitHub consegna da internet e non fa parte della tua rete privata.
> Un indirizzo `100.64–100.127.x.x` viene rifiutato subito; un nome MagicDNS
> `*.ts.net` viene segnalato, perché funziona **solo** se lo pubblichi con
> `tailscale funnel`. Non serve esporre niente: usa il **controllo periodico**
> qui sotto.

### Controllo periodico, quando il pannello non è raggiungibile

Un webhook ha bisogno che GitHub apra una connessione **verso** questa macchina,
e per moltissime installazioni self-hosted questo non può succedere: dietro NAT
senza porte aperte, su una rete Tailscale o WireGuard, su un portatile. Lì non
c'è niente da configurare meglio — la consegna fallisce prima di arrivare, e nei
log del pannello non resta nulla, perché il problema è la direzione della
connessione.

Quindi il pannello può anche **chiedere** invece di farsi avvisare. Nelle
impostazioni del progetto, *Deploy automatico → Come parte il deploy*:

- **Webhook** — GitHub avvisa a ogni push, il deploy parte subito. Richiede un
  pannello raggiungibile da internet.
- **Controllo periodico** — RunPanel guarda il branch a intervalli e distribuisce
  quando il commit cambia. Una richiesta in uscita, nessuna in entrata: funziona
  ovunque ci sia una connessione a internet.

L'intervallo è in Account → Preferenze, da 30 secondi a 30 minuti (predefinito 5
minuti). Un branch fermo risponde `304 Not Modified` grazie all'ETag, e GitHub
non conta le 304 nel limite orario di richieste: anche 30 secondi costano
praticamente nulla. Il ritardo massimo di un deploy è un intervallo.

Il primo giro dopo l'attivazione **registra** il commit corrente senza
distribuirlo — «distribuisci quello che arriva», non «distribuisci quello che
c'è adesso» — e i deploy così avviati compaiono nello storico con trigger
`poll`. Scegliendo il controllo periodico il webhook eventuale viene
disattivato, perché due trasporti attivi distribuirebbero lo stesso commit due
volte.

Il webhook resta configurabile a mano — URL e Secret sono lì da copiare — per i
repository che il token non amministra o per un pannello senza account collegato.

### Tornare a un commit preciso

Il pulsante accanto a **Deploy** apre la cronologia del repository: si sceglie il
branch, si sceglie il commit, e il progetto viene ricostruito da lì. Serve per
quando il commit appena distribuito è quello che ha rotto l'app, e l'alternativa
sarebbe un revert su GitHub e un altro push — una correzione che ha bisogno del
repository proprio mentre la produzione è ferma.

La scelta **resta**. Il progetto si ferma su quel commit: ogni deploy ricostruisce
quello, l'header lo dice con un'etichetta, e l'**auto-deploy viene sospeso** invece
di riportare il progetto in avanti al primo push. Le consegne che arrivano nel
frattempo restano nello storico come ignorate, con il motivo — un webhook che non
distribuisce deve dire perché. **Torna all'ultimo commit** scioglie il blocco e
distribuisce di nuovo la testa del branch.

Scegliere un branch diverso qui cambia il branch del progetto: da lì in avanti è
quello che webhook e controllo periodico seguono. L'elenco dei commit arriva
dall'API di GitHub, quindi vuole un account collegato; senza, o per un commit più
vecchio degli ultimi cento, c'è un campo dove incollare lo SHA.

Un avvertimento che il pannello ripete prima di procedere, perché è l'unico modo
in cui questa funzione rompe un'app senza che si veda: **le migrazioni del
database non tornano indietro**. Se la versione ripristinata si aspetta uno schema
più vecchio di quello che c'è, può non partire.

### Com'è fatto un deploy

1. **Coda** — i deploy dello stesso progetto sono serializzati, e quelli che si
   accavallano vengono accorpati: una raffica di push produce un deploy, non sei.
2. **Sorgente** — clone o pull del branch, con il commit registrato; oppure, se il
   progetto è fermo su un commit, il ripristino di quello.
3. **Contratto** — preset rilevato, `runpanel.json`, impostazioni del pannello.
4. **Build** — install e build secondo il runtime, con l'output in streaming.
5. **Release command** — eseguito una volta prima dell'avvio, in un container
   usa-e-getta o nella cartella del repository. Se fallisce, la nuova versione
   non parte: è il posto giusto per le migrazioni.
6. **Avvio** — PM2 o Docker, con la policy di riavvio e i limiti del contratto.
7. **Health check** — RunPanel sonda l'app finché non risponde. Senza, un'app che
   parte e muore un secondo dopo risulterebbe distribuita con successo.

Il **Re-Build** è la variante che pulisce prima: rimuove `node_modules`, `.next`,
`venv` e simili secondo il runtime, e poi rifà tutto dal codice già presente.

## Database e servizi

Un *servizio* è un database gestito dal pannello: un container etichettato, con
il proprio volume nominato e le credenziali cifrate.

| Motore | Versioni offerte |
|---|---|
| PostgreSQL | 18, 17, 16, 15, 14 |
| MySQL | 9, 8 |
| Redis | 8, 7, 6 |
| MongoDB | 8.0, 7.0 |

Sono le major che l'immagine ufficiale supporta oggi, meno i canali di anteprima
e quelli a cadenza breve. Un servizio già esistente non viene toccato quando
l'elenco cambia: la versione è salvata per riga e le ricreazioni usano quella.

### La console

Il pannello sa già nome del container, utente e password — le tre cose che
andresti a cercare prima di scrivere `docker exec` sull'host. La console le usa
al posto tuo, in tre modalità: il **client del motore** già autenticato
(`psql`, `mysql`, `redis-cli`, `mongosh`), una **shell** dentro il container, e
il **log** del container in diretta. Il log è in sola lettura e non viene
salvato da nessuna parte: esiste finché lo guardi.

Non è un emulatore di terminale ed è una scelta: `docker exec` con lo standard
input in pipe non può allocare un TTY, quindi si manda una riga alla volta. È
anche il motivo per cui i flag contano — senza `--table` MySQL risponde in
colonne separate da tabulazioni invece che con una tabella, e senza `--force`
il primo errore di sintassi chiuderebbe la sessione.

Prima della prima sessione c'è un avviso, e va accettato: da lì si cancellano
dati in modo irreversibile, e il pannello non tiene una copia.

### Cartelle condivise con l'host

Una cartella qualsiasi del container può comparire dove vuoi tu sull'host: la
configurazione, i log, gli upload, la directory dati. Più di una, ognuna
accendibile, spegnibile e in sola lettura. Vale per i servizi e per i progetti
con runtime Docker, con la stessa interfaccia.

**La prima volta il pannello semina**, ed è la parte che conta. Un bind non è una
sincronizzazione, è una **sostituzione**: Docker non copia niente e non fonde
niente, prende la cartella dell'host e la fa diventare quel percorso dentro il
container. Quello che c'era prima non viene cancellato, viene coperto. Quindi
senza semina aggiungeresti un bind e vedresti una cartella vuota — e il servizio
pure. Il pannello copia fuori il contenuto attuale prima di montare; da lì in poi
non c'è niente da tenere allineato, perché è la stessa cartella: modifichi da una
parte e cambia dall'altra, sottocartelle comprese, senza riavviare.

La semina va a due velocità. Una cartella qualunque è una copia. La **directory
dati del motore** è l'unico caso in cui sbagliare non si vede: `cp` senza `-a`
perde proprietario e permessi, e un Postgres che si trova davanti una cartella
vuota si inizializza da capo, funziona benissimo e ha perso tutto. Quel caso
ferma il servizio, copia conservando i permessi, ricrea, **chiede al motore se i
database ci sono ancora** e se non ci sono rimette tutto com'era da solo.

Se la cartella dell'host non è vuota si ferma e lo dice, con una casella per
adottare quello che c'è già senza copiarci sopra. E togliere un bind dalla
directory dati viene rifiutato finché non lo confermi: il motore tornerebbe sul
volume di prima, fermo a com'era quando l'avevi aggiunto, e ripartirebbe su dati
più vecchi senza dire niente.

### Dove stanno i file di un progetto nativo

Un progetto sotto PM2 non ha un container, quindi non ha bind: ha una cartella.
Dalle impostazioni la si sposta su un altro disco, con tutto dentro —
`node_modules` e build compresi, così riparte senza ricostruire.

Al vecchio posto resta un **collegamento**, e non è un dettaglio: dodici punti
del pannello costruiscono `data/repos/<slug>` a partire dal solo slug, e i
percorsi assoluti già salvati in `deployments.artifact_dir` e nel comando di
avvio puntano lì dentro. Il collegamento li fa risolvere tutti senza toccarne
nessuno. La copia di partenza non viene cancellata: resta finché non lo dici tu.

### Il collegamento a un progetto

Un servizio può essere collegato a un progetto, e allora gli fornisce la propria
connection URL in una variabile d'ambiente. Il collegamento ha un **interruttore
esplicito**:

- **Acceso**, il valore iniettato vince su una variabile che avessi definito a
  mano, e il pannello lo scrive nel log del deploy.
- **Spento**, il progetto usa le proprie variabili e il pannello non tocca niente.

La variabile ha un nome modificabile (`DATABASE_URL` per default, derivato dal
tipo). Due collegamenti attivi nello stesso progetto non possono rispondere alla
stessa chiave: il secondo viene rifiutato nominando il primo e proponendo un nome
alternativo, invece di sovrascriverlo in silenzio.

**L'host dipende da chi si collega**, e il pannello mostra la riga giusta per
ognuno: un container sulla rete del progetto raggiunge il servizio per nome del
container e sulla porta *interna*; tutto il resto — un processo PM2, un container
su bridge, il tuo `psql` — passa dalla porta pubblicata sull'host.

Un servizio può anche essere **autonomo**, senza progetto: allora non inietta
niente e resta un database che gestisci dal pannello.

### I database dentro un servizio

Un server di database ne ospita più d'uno. La pagina del servizio li elenca
leggendoli dal motore, non da una lista del pannello, e permette di crearli ed
eliminarli con la connection URL pronta per ognuno.

## Accesso di rete

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
riconosciuta, visto che la sua interfaccia dichiara una `/32` inutile), e gli
switch virtuali. Chi viene respinto compare nella pagina con un pulsante
**Consenti**, perché altrimenti una connessione rifiutata e un database fermo si
somigliano troppo visti dall'altra parte.

Due cose da sapere prima di accenderlo:

- **Fallisce in chiusura.** La porta è tenuta aperta dal processo del pannello.
  Se il pannello non gira, la porta è chiusa. Per un controllo di sicurezza è la
  direzione giusta in cui rompersi, ma è un cambiamento: prima il database di
  un'app restava raggiungibile anche a pannello spento.
- **Un'app sulla rete del progetto non è toccata.** Raggiunge il proprio database
  per nome del container su `runpanel-net-<slug>`, che non passa mai dal gate. Ci
  passa invece il traffico che arriva da `host.docker.internal`, ed è il motivo
  per cui fra i suggerimenti ci sono anche le sottoreti virtuali.

Non viene offerto dove non potrebbe essere onesto: un progetto **Compose**
pubblica le porte da un file che è tuo e RunPanel non lo riscrive, e un container
su `network: host` non ha una porta pubblicata da spostare. In entrambi i casi lo
dice, invece di mostrare un interruttore che non farebbe niente.

Per un processo nativo il pannello passa anche `HOST`/`HOSTNAME` e, per le CLI di
cui conosce la sintassi, il flag di bind. Un'app che ignora tutto questo resta su
tutte le interfacce alla porta spostata — quindi il pannello lo verifica, e lo
scrive nella pagina invece di mostrare una restrizione che non è tale.

## Backup e ripristino

Una *policy* dice cosa salvare, ogni quanto, e quanto tenerne.

### Cosa si può salvare

| Target | Cosa comprende |
|---|---|
| Un servizio | il dump del database, per intero o di un singolo database |
| Tutti i servizi | selettore: comprende quelli che creerai domani |
| Un progetto | configurazione, volumi, repository — a scelta |
| Tutti i progetti | stesso criterio |
| Il pannello | lo store di RunPanel, con o senza la chiave di cifratura |

I target sono selettori invece che elenchi fissi, così «ogni database» continua a
significare quelli che esistono quando il backup parte.

### Come vengono presi

Ogni dump gira **dentro il container a cui appartiene**, che è l'unico modo di
garantire che client e server siano della stessa versione: un `pg_dump` indietro
di una major produce un file che `pg_restore` rifiuta, e lo produce senza
lamentarsi. Lo store SQLite di RunPanel viene catturato con `VACUUM INTO` e poi
verificato con `PRAGMA integrity_check`, mai copiato — una copia presa sotto WAL
omette in silenzio le scritture più recenti.

### Dove finiscono

- **Disco locale** — `data/backups/archives/<anno>/<mese>`, con permessi 0600.
- **S3-compatibile** — AWS S3, Cloudflare R2, MinIO, Backblaze B2. La firma è
  SigV4 calcolata in casa, senza SDK. L'endpoint accetta `https://` ovunque e
  `http://` solo verso un indirizzo privato: un archivio contiene ogni variabile
  d'ambiente del pannello, e verso internet è il TLS a proteggerlo.

L'archivio è un normale zip con un `manifest.json` e un `checksums.txt` in
formato `sha256sum -c`, così si può verificare e spacchettare senza RunPanel. Le
variabili d'ambiente e le credenziali dei servizi al suo interno sono ricifrate
con la chiave di questo pannello; includere la chiave stessa è una scelta a
parte, ed esplicita.

### Pianificazione, retention, ripristino

| | |
|---|---|
| Pianificazione | cron a cinque campi più la famiglia `@daily`, nel fuso che scegli |
| Retention | numero, età e dimensione totale, insieme — l'archivio valido più recente non viene mai raccolto |
| Ripristino | guidato, con un backup automatico pre-ripristino che interrompe il ripristino se fallisce |

Il ripristino mostra il contenuto dell'archivio e ti fa scegliere voce per voce.
Lo store del pannello è l'unica cosa che non viene ripristinata a caldo: un file
che questo processo tiene aperto non può essere sostituito sotto di lui, quindi
il database ripristinato viene messo da parte e entra in servizio al riavvio
successivo, con il precedente conservato accanto.

## Avvio automatico

La pagina Autostart riferisce cosa questa macchina fa già e genera quello che non
fa: una unit systemd con percorsi assoluti, ordinata dopo `docker.service` e che
lo richiede, oppure uno script `@reboot` supervisionato quando systemd non c'è.
Se RunPanel gira da root la installa; altrimenti produce un unico blocco da
incollare. Non esegue mai `systemctl start`: metterebbe un secondo pannello sulla
porta accanto a quello in esecuzione.

Controlla anche le cose che rendono inutile l'avvio automatico quando mancano: se
Docker stesso è abilitato all'avvio, e se `pm2 save` è mai stato eseguito — senza,
PM2 non rimette su niente dopo un riavvio, anche quando il pannello torna.

Dentro il pannello, ogni progetto e ogni servizio ha un interruttore, un ordine,
un ritardo, e se aspettare che risponda prima di avviare il successivo. Il
riconciliatore che applica tutto questo all'avvio è una passata di **riparazione**:
aspetta che i riavvii automatici di Docker si assestino e avvia solo ciò che è
ancora giù, e non innesca mai un build.

La unit generata contiene `KillMode=process`, e non è un dettaglio: PM2 viene
avviato dal pannello, quindi finisce nel cgroup della sua unit, e col
comportamento predefinito di systemd un `systemctl stop runpanel` uccide anche
lui e tutti i progetti con runtime nativo che supervisiona. I container Docker
non sono mai coinvolti, appartengono al cgroup di Docker. Se la unit è stata
installata prima, la pagina Autostart lo dice e basta reinstallarla.

Lo stato mostrato negli elenchi viene riverificato da solo, ogni mezzo minuto e
al termine della riconciliazione d'avvio. Prima era la memoria dell'ultimo
comando dato dal pannello, non dello stato della macchina: tutto ciò che si
ferma senza passare da qui — un riavvio, un processo ucciso per memoria, un
`docker stop` da una shell, il pannello stesso che scende portandosi dietro i
suoi figli — lasciava il pallino verde acceso per sempre. Ora il pannello
controlla, e un progetto può passare a **Fermo** da sé senza che nessuno l'abbia
spento in quel momento: significa che non era più su da prima. Il controllo non
avvia e non ferma niente, e per dichiarare fermo qualcosa che risultava avviato
aspetta due letture d'accordo, così un `pm2` che non risponde per un istante non
tinge di rosso l'intero pannello.

## Aggiornare il pannello

RunPanel si installa clonandolo, quindi la cartella da cui gira è un working tree
git: è tutto quello che serve perché sappia se c'è una versione più recente — e
anche per sapere *quale* versione è. La versione mostrata è `v0.1.0+125`: il
numero dopo il `+` è il conteggio dei commit sul ramo principale
(`git rev-list --count --first-parent`), che sale da solo e non va ricordato,
mentre `0.1.0` di `package.json` è fermo da sempre. Su un checkout shallow il
conteggio non ha senso e il pannello mostra lo SHA. Ogni
sei ore — l'intervallo si cambia dalla pagina — fa un `git fetch` sul proprio
remote e confronta: solo traffico in uscita, esattamente come per i progetti, e
per un repository pubblico non serve alcun token. Quando il branch si è mosso
compare una striscia in cima a ogni pagina con il numero di commit e un pulsante
**Aggiorna**; la pagina
Aggiornamenti mostra l'elenco dei commit, così premere quel pulsante è una
decisione e non un atto di fede.

Il controllo **non applica mai niente da solo**. È la differenza deliberata con
l'auto-deploy dei progetti: chi accende l'auto-deploy ha chiesto che il proprio
codice venga ricostruito, mentre nessuno chiede che la cosa che sta guardando si
riavvii sotto di lui.

Premuto il pulsante, il pannello copia lo store, scarica, allinea il checkout,
installa le dipendenze, builda e si riavvia. Due dettagli non ovvi:

- **La build non va in `.next`.** `next build` svuota e riscrive la sua cartella,
  e il pannello in esecuzione legge da lì a ogni richiesta: costruire sul posto
  romperebbe la pagina che sta mostrando l'avanzamento, e una build fallita a
  metà lascerebbe un pannello che non riparte. La nuova versione si costruisce in
  `.next-update` e prende il posto di quella in uso con due rename, solo dopo
  essere stata verificata. La precedente resta in `.next-old` fino al riavvio
  successivo.
- **Il riavvio è un'uscita.** Il pannello esce con codice 75 e a rimetterlo su ci
  pensa chi lo supervisiona già: systemd con `Restart=always`, o il ciclo dello
  script `@reboot`. Non serve `systemctl` né alcun privilegio. `KillMode=process`
  garantisce che PM2, i progetti nativi e i container non vengano toccati.

Se qualcosa fallisce prima dello scambio, il checkout torna al commit di partenza
e le dipendenze vengono reinstallate: `.next` non è mai stato toccato, quindi il
pannello continua a girare sulla versione di prima senza accorgersi di niente.

L'aggiornamento viene rifiutato quando il pannello non è un checkout git, quando
HEAD è staccato, quando gira in un container — lì la modifica vivrebbe nel layer
scrivibile e sparirebbe alla prima ricreazione, quindi la strada è ricostruire
l'immagine — e su Windows, dove la cartella di build non si può rinominare mentre
il processo la tiene aperta. Se non c'è nessun supervisore l'aggiornamento viene
comunque scaricato e costruito, ma si ferma **prima** dello scambio e ti consegna
i due comandi da eseguire: una build scambiata sotto un processo che continua a
girare non funzionerebbe.

Le modifiche locali non committate vengono scartate (`git reset --hard` seguito da
`git clean -fd`), ed è necessario: `lib/icons.generated.ts` è tracciato e il
`prebuild` lo rigenera, quindi l'albero di un'installazione è sporco dopo ogni
build. Il `clean` è senza `-x`, quindi non tocca niente di ignorato — `data/`,
`node_modules/`, `.next` — e i file `.env*` sono esclusi esplicitamente. Quello
che sta per essere rimosso viene elencato nel log prima di rimuoverlo.

Prima di iniziare, il pannello prende una copia del proprio store con
`VACUUM INTO` e ne scrive il percorso nel log: le migrazioni girano da sole al
boot, e una migrazione che fallisce lascia un pannello spento, cioè senza
un'interfaccia da cui rimediare. Un aggiornamento viene rifiutato mentre c'è un
deploy o un backup in corso, perché il riavvio li interromperebbe a metà.

Se il pannello non dovesse tornare su, i comandi per rimettere la versione
precedente sono in due posti che non richiedono un pannello funzionante: stampati
nel journal appena prima dell'uscita, e in `<dataDir>/panel-update.json`.

## Notifiche su Telegram

Il pannello sa avvisarti quando succede qualcosa che vorresti sapere senza avere
il pannello aperto. Si configura da **Impostazioni → Notifiche Telegram**: crei
un bot con `@BotFather`, incolli il token, scrivi un messaggio qualsiasi al bot e
premi **Rileva** — il pannello chiede a Telegram chi gli ha scritto e ti fa
scegliere la chat, così non devi andare a cercarti l'id da un'altra parte.

Telegram è scelto per la stessa ragione per cui esiste il controllo periodico dei
repository: **il pannello parla solo in uscita**. Non serve che sia raggiungibile
da internet, il che è vero per moltissime installazioni self-hosted — dietro NAT,
su una rete Tailscale, su un portatile. Il rovescio della medaglia è che al bot
non si può parlare: non ci sono comandi, manda e basta.

Il token è cifrato a riposo come quello di GitHub e non viene mai restituito da
questa pagina: lo schermo sa solo se ce n'è uno.

### Cosa viene notificato

| Evento | Quando |
|---|---|
| **Progetto o servizio fermo** | Il processo non c'è più e non è stato il pannello a fermarlo |
| **Docker non risponde** | Il daemon è irraggiungibile, e di nuovo quando torna |
| **Deploy concluso** | Sempre per i deploy automatici; per quelli manuali solo se falliscono |
| **Backup concluso** | Riuscito, parziale o fallito, con artefatti, dimensione e durata |
| **Aggiornamento disponibile** | Il controllo periodico ha trovato commit nuovi su RunPanel |
| **Il pannello è ripartito** | Dopo un riavvio o un aggiornamento |
| **Spazio su disco** | Sotto il 10% libero sulla cartella dei dati, e quando rientra |

Ogni voce ha il suo interruttore: una che fa troppo rumore si spegne senza
perdere le altre.

I crash arrivano dallo stesso passaggio che tiene onesta la colonna dello stato
(`services/status-reconcile.ts`), che è l'unico punto del pannello che scopre che
un processo se n'è andato *senza che gli sia stato chiesto*. Sono già confermati
su due letture, quindi un `pm2` che non risponde per un istante non manda niente.

Il deploy manuale non viene annunciato quando riesce, e non è una svista: lo stai
già guardando, con il log che scorre. Se fallisce sì, perché a quel punto la
scheda l'hai probabilmente chiusa.

### Perché non ti sommerge

Tutto è **edge-triggered**: conta il passaggio, non lo stato. "Il disco è all'8%"
sarebbe vero ogni cinque minuti per una settimana; quello che viene notificato è
il momento in cui ci è entrato, e poi quello in cui ne è uscito. La soglia del
disco ha due punti di isteresi, perché un disco che si sta riempiendo sta seduto
esattamente sulla soglia ed è lì che un monitor senza isteresi comincia ad
alternare allarme e cessato allarme all'infinito.

Sopra a questo c'è un silenzio di quindici minuti per evento e per soggetto: un
progetto sotto una restart policy che va in crash-loop verrebbe segnalato ad ogni
sweep, e il primo messaggio dice già tutto quello che direbbe il ventesimo. Per
soggetto, non globale, così un progetto che sbatte non copre un altro che cade
nello stesso momento.

L'aggiornamento del pannello viene annunciato quando cambia il commit di
destinazione, non quando esiste un aggiornamento: il controllo gira ogni sei ore
e un aggiornamento non applicato resta lì: notificarlo ogni volta significherebbe
quattro messaggi al giorno per la stessa notizia.

### Se la notifica non parte

Non succede niente. `notify()` non lancia mai, non blocca mai chi la chiama e non
fa aspettare nessuno: un deploy non fallisce perché Telegram non risponde. Un
invio non riuscito finisce nel log del pannello con il motivo, tradotto dove
Telegram è particolarmente criptico — `chat not found` di solito vuol dire che al
bot non hai ancora scritto, e finché non gli scrivi tu un bot non può scriverti.

## Registri privati

Le credenziali dei registri Docker si inseriscono dal pannello, sono cifrate a
riposo e riscritte nella configurazione di Docker all'avvio — la directory dei
dati può sopravvivere a una ricostruzione del container, e un file di
autenticazione mancante si manifesta come un `pull access denied` che non dice
niente di utile.

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

### Metterlo su internet

Termina il TLS davanti al pannello e digli dietro quanti proxy si trova:

```bash
RUNPANEL_TRUSTED_PROXY_HOPS=1
```

Senza, il pannello non può credere a nessun indirizzo del client —
`X-Forwarded-For` viene esteso da ogni hop, quindi la prima voce è quella scelta
dal client — e ripiega su un unico limite di accesso valido per tutto l'account.
Il cookie di sessione è marcato `Secure` nelle build di produzione, e i browser
lo accettano solo su HTTPS o su localhost.

## Architettura

```
app/
  (auth)/login          setup iniziale e accesso
  (panel)/              panoramica, progetti, servizi, monitor, storage, backup, impostazioni
  api/                  handler REST; /projects/:id/stream è il canale SSE
lib/
  db/                   schema Kysely, migrazioni, entrambi i dialetti
  deploy-contract.ts    il contratto, il suo parser e i controlli preliminari
  ip-access.ts          confronto CIDR, e le reti della macchina
  service-versions.ts   quali versioni dei motori sono offerte
  hooks/                useProjectStream (SSE), useResource (polling)
services/
  deploy-pipeline.ts    l'orchestratore del deploy
  deploy-queue.ts       serializzazione e accorpamento per progetto
  access-gate.ts        il gate TCP davanti a una porta limitata
  backup/               policy, dump, archivi, destinazioni, ripristino
  autostart/            rilevamento, generazione della unit, riconciliazione
  panel-update/         controllo, build in staging, scambio, uscita per riavvio
  notify/               eventi, testo dei messaggi, bot Telegram, watch dell'host
  docker/               cli, etichette di proprietà, immagini, volumi, statistiche, gc
  builders/             node, docker, static, compose, custom
  process-drivers/      pm2, docker, compose
  service-templates/    postgresql, mysql, redis, mongodb
tests/                  suite end-to-end, un server isolato ciascuna
data/                   stato a runtime (in gitignore)
```

Tutte le route `/api` richiedono una sessione, tranne l'accesso e i webhook. Le
uniche superfici pensate per l'esterno sono il webhook GitHub per progetto e i
canali SSE, che comunque richiedono la sessione.

## Sviluppo

```bash
npm run dev        # server di sviluppo
npm run typecheck
npm run lint
npm test           # suite completa
npm run test:quick # salta le suite che richiedono Docker
```

Il runner dichiara cosa la macchina è in grado di fare e salta il resto invece
di fallire: le suite che richiedono un daemon Docker, e quella sul runtime nativo
che richiede un PM2 vero (`npm i -g pm2`). Entrambe compaiono come `SKIP` nel
riepilogo, così una corsa verde non nasconde mai terreno non testato.

Ogni suite riceve un server tutto suo su una directory dati temporanea. Alcune
sono *standalone*: caricano direttamente il modulo da testare, senza server né
daemon, e coprono le regole pure — confronto CIDR, contratto di deploy, firma
SigV4, iniezione delle variabili, versioni dei motori.

Le suite Postgres richiedono un database:

```bash
docker run -d --name rp-test-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=runpanel -e POSTGRES_DB=runpanel_test \
  -p 55432:5432 postgres:18-alpine

RUNPANEL_TEST_PG_URL=postgresql://runpanel:test@127.0.0.1:55432/runpanel_test npm test
```

Le icone sono raccolte in un sottoinsieme generato. Dopo averne aggiunta una,
`npm run icons` — anche se `predev` e `prebuild` lo eseguono già per te, e il
build fallisce su un nome di icona che non esiste.

## Limiti noti

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
