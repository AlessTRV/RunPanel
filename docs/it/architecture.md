[← RunPanel](../../README.md) · **Italiano** · [English](../en/architecture.md)

---

# Architettura e sviluppo

## Architettura

```
app/
  (auth)/login          setup iniziale e accesso
  (panel)/              panoramica, progetti, servizi, monitor, storage, backup, impostazioni
  api/                  handler REST; /projects/:id/stream è il canale SSE
lib/
  db/                   schema Kysely, migrazioni, entrambi i dialetti
  deploy-contract.ts    il contratto, il suo parser e i controlli preliminari
  deploy-phases.ts      gli otto punti a cui si aggancia un comando una tantum
  ip-access.ts          confronto CIDR, e le reti della macchina
  service-versions.ts   quali versioni dei motori sono offerte
  hooks/                useProjectStream (SSE), useResource (polling)
services/
  deploy-pipeline.ts    l'orchestratore del deploy
  one-time-commands.ts  la coda una tantum: presa, esecuzione, esito, cronologia
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
