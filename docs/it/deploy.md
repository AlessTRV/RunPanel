[← RunPanel](../../README.md) · **Italiano** · [English](../en/deploy.md)

---

# Distribuire un progetto

## Sorgenti

- **GitHub** — collega un token nella pagina GitHub e scegli il repository da un
  elenco, con i branch caricati dall'API. In alternativa incolla un URL
  `https://` pubblico.
- **Upload ZIP** — per il codice che non sta su GitHub. L'archivio viene
  spacchettato in-process, rifiutando le voci con traversal e i link, con un
  limite sia sull'archivio sia sul decompresso.

## Runtime e preset

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

## Il contratto di deploy

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

### `runpanel.json`

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
`docker.extraHosts`, `docker.context`, `docker.dockerfile`, `docker.target`,
`envFile.path`, `healthcheck.path` e `healthcheck.port`. Il resto del contratto descrive come
costruire e avviare l'app, che è affare del repository; questi descrivono cosa
può raggiungere fuori dal proprio container, che è affare tuo. Scegliere un
runtime Docker è una scelta di isolamento, e un `runpanel.json` non deve poter
consegnare a sé stesso l'host. Quando ci prova, il log del deploy nomina i campi
che ha scartato.

Per la stessa ragione i [comandi una tantum](automation.md#comandi-una-tantum) non fanno parte
del contratto: stanno in una tabella loro, dove un `runpanel.json` non arriva.

## Variabili d'ambiente

Le variabili del progetto si gestiscono nella scheda **Variabili** e sono cifrate
a riposo. Vengono passate al processo o al container, e — se `envFile` è
attivo — scritte anche in un file che l'app può leggere da sola.

Le variabili con prefisso `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` o `REACT_APP_`
vengono passate anche al **build**, non solo al runtime. I frontend le incorporano
nel bundle client, quindi fornirle solo a runtime spedisce il valore sbagliato —
o fa fallire un Dockerfile che le pretende.

## Com'è fatto un deploy

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
