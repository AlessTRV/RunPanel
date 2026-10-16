[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/architecture.md)

---

# Architettura e sviluppo

## Architettura

```
proxy.ts                rifiuta ogni /api senza sessione o firma di cluster valida
instrumentation.ts      all'avvio: migrazioni, ripristini in sospeso, poi i timer
next.config.ts          header di sicurezza; distDir letto da RUNPANEL_DIST_DIR (non toglierlo)
app/
  (auth)/login          primo avvio (proprietario o collegamento a un cluster) e accesso; invite/, setup-email/
  (panel)/              panoramica, progetti, servizi, backup, monitor
    (system)/           Sistema a tab: diagnostics, autostart, updates, storage, servers
    (access)/           Accessi a tab: users, audit
    (settings)/         Impostazioni a tab: account, settings (Pannello), github
  api/                  handler REST; /projects/:id/stream è il canale SSE
    cluster/            collegamento, ping, directory, membri, segreto
    nodes/[id]/[...]    inoltro firmato di una chiamata a un altro server
components/             interfaccia; components/ui/ è il kit (HeroUI 3, Tailwind 4)
lib/
  env.ts, config.ts     variabili d'ambiente validate, percorsi dei dati, chiave segreta
  db/                   schema Kysely, migrazioni, entrambi i dialetti
  nav.ts                menu, tab delle sezioni, palette dei comandi
  authz.ts              chi può fare cosa: livelli, grant, permessi, nessun import
  auth-guard.ts         require* con cui comincia ogni handler (401, 403, 404)
  principal.ts          carica account e riferimenti per authz.ts
  users.ts              account, inviti, grant; emette authzEvents
  stream-guard.ts       ricontrollo dei permessi per SSE e shell aperte
  request-origin.ts     rifiuto delle scritture da un'altra origine
  host-guard.ts         cosa richiede il permesso "Accesso all'host"
  audit.ts              registro attività (regole pure in audit-filter.ts)
  cluster-sign.ts       firma HMAC delle richieste tra server, nessun import
  cluster-directory.ts  merge della directory replicata, nessun import
  cluster-auth.ts       verifica delle firme, una sola volta ciascuna
  node-api.ts           /api/x → /api/nodes/<id>/x per il server selezionato
  server-url.ts         il server nell'indirizzo della pagina (?server=)
  cluster-merge.ts      unione delle risposte dei server e avvisi per server, nessun import
  deploy-contract.ts    il contratto, il suo parser e i controlli preliminari
  deploy-phases.ts      i punti a cui si aggancia un comando una tantum
  ip-access.ts          confronto CIDR, e le reti della macchina
  service-versions.ts   quali versioni dei motori sono offerte
  hooks/                stream SSE, polling (useResource), server selezionato (useNode), utente (useMe)
services/
  deploy-pipeline.ts    l'orchestratore del deploy
  deploy-queue.ts       un deploy alla volta per progetto, più uno in attesa
  deploy-poll.ts        il deploy automatico a polling
  one-time-commands.ts  la coda una tantum: presa, esecuzione, esito, cronologia
  access.ts, access-gate.ts  i gate TCP davanti alle porte limitate
  cluster/              stato del cluster, client firmato, fan-out su tutti i server, directory, join, sync
  backup/               policy, dump, archivi, destinazioni, ripristino
  autostart/            rilevamento, generazione della unit, riconciliazione
  panel-update/         controllo, build in staging, scambio, uscita per riavvio
  notify/               eventi, testo dei messaggi, bot Telegram, controlli dell'host
  docker/               cli, registry, etichette, immagini, volumi, statistiche, pulizia
  builders/             node, docker, static, compose, custom
  process-drivers/      pm2, docker, compose
  service-templates/    postgresql, mysql, redis, mongodb
scripts/                build con tetto di memoria, lint, generazione delle icone
tests/                  runner, harness e suite
data/                   stato a runtime (in gitignore)
```

Ogni route `/api` passa da `proxy.ts`, che rifiuta le richieste senza sessione. Fanno eccezione le route pubbliche (accesso, uscita, controllo dello stato di accesso, inviti, webhook GitHub, ingresso nel cluster con token), le chiamate firmate tra server del cluster, e le due route con corpi grandi (upload ZIP e inoltro a un altro server), che fanno gli stessi controlli da sé. Ogni handler comincia comunque con un guard di `lib/auth-guard.ts`, e `authz-coverage-unit` fallisce se uno ne è privo. Il modello dei permessi è in [Utenti e permessi](users.md), il cluster in [Più server](multi-server.md).

## Sviluppo

```bash
npm run dev            # server di sviluppo
npm run build          # build di produzione, con un tetto alla memoria
npm start              # avvia l'ultima build
npm run typecheck
npm run lint
npm test               # suite completa
npm test -- <suite…>   # solo le suite indicate
npm run test:quick     # salta le suite che richiedono Docker
npm run icons          # rigenera le icone dopo averne aggiunta una
```

Il build usa al massimo il 40% della RAM (tra 1 e 4 GB), perché il pannello si ricostruisce sulla stessa macchina dei progetti; un `NODE_OPTIONS` già impostato vince.

Ci sono due tipi di suite:

- **standalone** (tutte le `*-unit` e poche altre): caricano direttamente il modulo da testare, senza server né daemon, e coprono le regole pure: confronto CIDR, contratto di deploy, firma, merge della directory, migrazioni.
- **con server**: ognuna avvia `next start` su una directory dati temporanea. Usano l'**ultima build**, quindi dopo una modifica serve `npm run build` prima di lanciarle.

Il runner salta quello che la macchina non può fare invece di fallire: le suite che richiedono Docker (`--no-docker` le esclude), e `native-runtime` e `one-time-deploy`, che richiedono PM2 (`npm i -g pm2`; `--no-pm2` le esclude). Compaiono come `SKIP` nel riepilogo.

Le suite che dichiarano il driver Postgres girano anche su Postgres solo con `RUNPANEL_TEST_PG_URL` impostata:

```bash
docker run -d --name rp-test-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=runpanel -e POSTGRES_DB=runpanel_test \
  -p 55432:5432 postgres:18-alpine

RUNPANEL_TEST_PG_URL=postgresql://runpanel:test@127.0.0.1:55432/runpanel_test npm test
```

Le icone sono un sottoinsieme generato: `predev` e `prebuild` lo rigenerano, e il build fallisce su un nome di icona che non esiste.
