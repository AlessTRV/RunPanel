[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/deploy.md)

---

# Distribuire un progetto

Un progetto vive sul server su cui è stato creato: con [più server](multi-server.md), crealo con quel server selezionato. Cambiare sorgente, branch, repository o caricare file richiede il permesso **Accesso all'host** (vedi [Utenti e permessi](users.md)).

## Sorgenti

- **GitHub**: collega un token nella pagina **GitHub** e scegli il repository da un elenco, con i branch letti dall'API. In alternativa incolla un URL `https://` pubblico. In un cluster il token è condiviso da tutti i server.
- **Upload ZIP**: per il codice che non sta su GitHub. Limiti: 100 MB di archivio, 1 GB decompresso, 50.000 voci. Le voci con traversal e i link vengono rifiutati, una singola cartella principale viene tolta, e i file nuovi sostituiscono i vecchi solo a estrazione riuscita. Durante un deploy l'upload è rifiutato. Caricare non avvia un deploy.

## Runtime e preset

| Runtime | Cosa fa | Chi lo esegue |
|---|---|---|
| `node` | Rileva il package manager dal lockfile e usa gli script | PM2 |
| `custom` | Solo i comandi che scrivi tu, in qualsiasi linguaggio | PM2 |
| `docker` | Costruisce il Dockerfile del repository | Docker |
| `compose` | Avvia lo stack descritto dal compose file | Docker |
| `static` | Serve una cartella di build; arriva dal preset Vite o da **Applica i comandi** | PM2 |

I **preset** sono punti di partenza per forme di repository comuni: Dockerfile, Next.js server, Vite/SPA statica, Python (uvicorn/gunicorn), Go. Ognuno porta un runtime e i comandi che gli servono.

- Alla creazione la scelta di default è **Rileva da solo**: il preset viene riconosciuto a ogni deploy, guardando i file del repository. Puoi sceglierne uno a mano quando la forma del repository non si vede da fuori.
- In **Impostazioni › Build e avvio** scegli un preset e premi **Applica i comandi**: runtime e comandi vengono compilati con i suoi. Niente viene salvato finché non salvi.

La precedenza, dal basso: il preset, poi il `runpanel.json` del repository, poi le impostazioni del pannello.

## Dove stanno i file

Il codice di un progetto sta in `data/repos/<slug>`. Per un progetto nativo, dalle impostazioni si può spostare la cartella su un altro disco con tutto dentro, `node_modules` e build compresi, così riparte senza ricostruire. Al vecchio posto resta un collegamento, e la copia di partenza resta finché non la cancelli tu.

## Il contratto di deploy

Quello che a RunPanel serve sapere per distribuire un progetto. I campi sono neutri rispetto al runtime e ognuno li traduce a modo suo.

| Campo | Docker | PM2 / nativo |
|---|---|---|
| `buildEnv`, `buildEnvPrefixes` | un `--build-arg` per voce | ambiente di install e build |
| `envFile` | scritto 0600 e montato in sola lettura | scritto 0600 nel repository (percorso relativo alla sua radice) |
| `commands.release` | container usa-e-getta prima dell'avvio | comando nella cartella del repository |
| `healthcheck` | sondato da RunPanel dopo l'avvio | identico |
| `runtime.restartPolicy` | `--restart` | `autorestart` di PM2 |
| `runtime.memory` / `cpus` / `shmSize` | limiti del container | `max_memory_restart` dove applicabile |
| `docker.network` / `hostname` / `capAdd` / `extraHosts` | flag di `docker run` | non applicabile |
| `build.timeoutSec` / `nodeOptions` | tempo massimo del build (default 900 s) e opzioni di Node | identico |

Per **Compose** valgono comandi, variabili e health check; policy di riavvio, limiti, rete e `envFile` li decide il compose file. `capAdd` ed `extraHosts` non hanno un campo nell'interfaccia.

### `runpanel.json`

Un repository può dichiarare come vuole essere distribuito:

```json
{
  "version": 1,
  "commands": { "release": "npx prisma migrate deploy" },
  "envFile": { "enabled": true },
  "healthcheck": { "startPeriodSec": 45, "timeoutSec": 120 },
  "runtime": { "restartPolicy": "unless-stopped", "memory": "2g" }
}
```

Dove entrambi indicano un valore vince il pannello. Un file non valido viene ignorato per intero.

Alcuni campi sono **solo del pannello** e vengono scartati se arrivano dal repository, con una riga nel log del deploy: `docker.mounts`, `docker.capAdd`, `docker.network`, `docker.extraHosts`, `docker.context`, `docker.dockerfile`, `docker.target`, `envFile.path`, `healthcheck.path` e `healthcheck.port`. Decidono cosa il progetto raggiunge fuori dal proprio container, dove finiscono i segreti decifrati e cosa sonda il pannello: un repository non deve poterli scegliere da sé. Per lo stesso motivo i [comandi una tantum](automation.md#comandi-una-tantum) stanno fuori dal contratto.

## Variabili d'ambiente

Si gestiscono nella scheda **Variabili** (con **Importa .env** per incollarne un file) e sono cifrate a riposo. Valgono dal deploy o riavvio successivo, non al salvataggio. Vengono passate al processo o al container e, se `envFile` è attivo, scritte anche in un file che l'app legge da sola. Limiti: 500 variabili, 64 KB per valore.

RunPanel aggiunge `NODE_ENV=production` e, per i runtime nativi, `PORT` (3000 se non indicata). Le variabili di un [servizio collegato](databases.md) prevalgono su quelle con lo stesso nome.

Le variabili con prefisso `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` o `REACT_APP_` arrivano anche al **build**, perché i frontend le incorporano nel bundle. L'elenco dei prefissi (`buildEnvPrefixes`) e le chiavi aggiuntive (`buildEnv`) si cambiano nel contratto.

## Com'è fatto un deploy

1. **Coda**: un deploy alla volta per progetto. Le richieste che arrivano nel frattempo diventano **un** deploy successivo; quel deploy in attesa vive in memoria e si perde se il pannello si riavvia.
2. **Sorgente**: clone o pull del branch, oppure il commit su cui il progetto è fermo. Il checkout viene riportato al commit (`reset --hard` e `clean`): le modifiche fatte dal file manager a file non ignorati si perdono.
3. **Contratto**: preset, `runpanel.json`, impostazioni del pannello.
4. **Build**: install e build secondo il runtime, con l'output in diretta.
5. **Release command**: eseguito una volta, al massimo 10 minuti. Se fallisce la nuova versione non parte e la vecchia resta su: è il posto per le migrazioni.
6. **Avvio**: la versione vecchia si ferma solo adesso (sui runtime nativi Windows, prima del build), poi PM2 o Docker avviano la nuova con policy e limiti del contratto.
7. **Health check**: RunPanel sonda l'app ogni 2 secondi, dopo 3 secondi di attesa e per al massimo 30 (`startPeriodSec`, `timeoutSec`). Passa qualsiasi risposta HTTP, a meno che il contratto indichi `expectStatus`; un container senza porta deve solo restare acceso.

Se l'health check fallisce, il deploy è segnato come fallito con le ultime 40 righe del processo nel log, e il progetto va in errore. **Non c'è un ritorno automatico alla versione precedente**, che è già stata fermata: per tornare indietro vedi [Tornare a un commit](automation.md#tornare-a-un-commit).

**Re-build da zero** (menu **Altro**) ferma l'app, cancella i file di build del runtime e rifà tutto dal codice già presente, senza `git pull`:

- node: `.next`, `node_modules`, `dist`, `build`, `.turbo`;
- static: `dist`, `build`;
- custom: `venv`, `__pycache__`, `dist`, `build`;
- Docker e Compose: niente da cancellare.

Un progetto caricato da ZIP tiene `dist` e `build`. Non si può fare su un progetto fermo su un commit.
