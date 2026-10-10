[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/architecture.md)

---

# Architettura e sviluppo

## Architettura

```
app/
  (auth)/login          setup iniziale e accesso; invite/ e setup-email/
  (panel)/              panoramica, progetti, servizi, backup, monitor
    (system)/           Sistema a tab: diagnostics, autostart, updates, storage
    (access)/           Accessi a tab: users, audit
    (settings)/         Impostazioni a tab: account, settings (Pannello), github
  api/                  handler REST; /projects/:id/stream è il canale SSE
lib/
  db/                   schema Kysely, migrazioni, entrambi i dialetti
  authz.ts              chi può fare cosa: livelli, grant, permessi, nessun import
  auth-guard.ts         require* con cui comincia ogni handler (401, 403, 404)
  principal.ts          carica account e riferimenti per authz.ts
  users.ts              account, inviti, grant; emette authzEvents
  stream-guard.ts       ricontrollo dei permessi per SSE e shell aperte
  host-guard.ts         cosa richiede il permesso "Accesso all'host"
  audit.ts              registro attività (regole pure in audit-filter.ts)
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

Tutte le route `/api` richiedono una sessione, tranne l'accesso, gli inviti e i
webhook. Ogni handler comincia con un guard di `lib/auth-guard.ts`, e
`authz-coverage-unit` fallisce se uno ne è privo: una route deve dire cosa
protegge. Il modello dei permessi è in [Utenti e permessi](users.md). Le
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
che richiede un PM2 vero (`npm i -g pm2`). Entrambe compaiono come `SKIP` nel riepilogo.

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
