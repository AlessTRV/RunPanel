[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/configuration.md)

---

# Configurazione

Tutto sta in `.env` nella cartella del pannello; `.env.example` è la versione commentata. Le variabili della tabella sono controllate all'avvio: un valore sbagliato ferma il pannello con un messaggio, invece di far fallire più tardi la prima richiesta che lo usa.

| Variabile | Default | Cosa fa |
|---|---|---|
| `RUNPANEL_SECRET` | generata in `<data>/.secret` (permessi 0600) | Chiave di cifratura, esadecimale, almeno 64 caratteri. Vedi sotto |
| `RUNPANEL_DATA_DIR` | `./data` | Store, repository, log, archivi |
| `PORT` | `3000` | Porta del pannello |
| `RUNPANEL_DB_DRIVER` | `sqlite` | `sqlite` o `postgres` |
| `RUNPANEL_DB_FILE` | `<data>/runpanel.db` | Solo con `sqlite`; un percorso relativo parte dalla cartella del pannello |
| `RUNPANEL_DATABASE_URL` | — | Solo con `postgres` (accetta anche `DATABASE_URL`) |
| `RUNPANEL_PG_HOST` `_PORT` `_USER` `_PASSWORD` `_DATABASE` | porta `5432` | Alternativa all'URL; host, utente e database obbligatori |
| `RUNPANEL_PG_SSL` | `disable` | `disable`, `require`, `no-verify` |
| `RUNPANEL_PG_POOL_MAX` | `10` | Connessioni massime del pool, da 1 a 100 |
| `RUNPANEL_TRUSTED_PROXY_HOPS` | `0` | Quanti reverse proxy stanno davanti, da 0 a 10. Vedi [Metterlo su internet](#metterlo-su-internet) |
| `RUNPANEL_DISABLE_SCHEDULERS` | spento | `1`, `true` o `yes`: spegne timer e gate d'accesso. Vedi sotto |
| `RUNPANEL_SETUP_TOKEN` | generato a ogni avvio | Fissa il token del primo avvio, che serve anche a [collegare il server a un cluster](multi-server.md). Non validato |
| `RUNPANEL_DEV_ORIGINS` | — | Solo `next dev`: host aggiuntivi, separati da virgola, con `*` e `**` come jolly (niente CIDR). Non validato |

**La chiave segreta.** Cifra le variabili dei progetti, le credenziali dei servizi, i registry, le destinazioni di backup, il token GitHub e il bot Telegram. Se cambia o va persa, tutti questi valori diventano illeggibili: salvala insieme ai backup. Con [più server](multi-server.md) ogni installazione ha la propria; i valori condivisi (token GitHub, bot Telegram) vengono cifrati di nuovo da ciascun server.

**I timer di fondo.** `RUNPANEL_DISABLE_SCHEDULERS` serve per un'istanza di prova accanto a quella vera. Spegne pulizia Docker, backup e riavvii pianificati, deploy automatico, controllo degli aggiornamenti, sincronizzazione del cluster, controlli di stato con le relative notifiche e la ripartenza di progetti e servizi dopo un riavvio della macchina. Spegne anche i gate d'accesso: le porte limitate restano chiuse.

**Cosa vedono i progetti.** Nessuna variabile `RUNPANEL_*`, né `DATABASE_URL`, arriva ai comandi di build, ai processi o ai container dei progetti: la chiave segreta, le credenziali dello store e il token di setup restano del pannello.

## Lo store: SQLite o Postgres

```bash
RUNPANEL_DB_DRIVER=postgres
RUNPANEL_DATABASE_URL=postgresql://user:pass@host:5432/runpanel
```

SQLite è il default ed è il caso per cui il pannello è pensato. Postgres serve se lo store deve stare fuori dalla macchina o essere salvato dalla tua infrastruttura. Schema e query sono gli stessi sui due driver. Le migrazioni si applicano all'avvio, prima della prima richiesta.

## Registry privati

Si aggiungono da **Impostazioni › Pannello › Registry privati**. Le credenziali sono cifrate nello store e scritte a ogni avvio in una configurazione Docker del pannello (`<data>/docker-config`), mai in `~/.docker`: le tue credenziali personali non si mescolano con quelle del pannello.

## Metterlo su internet

Termina il TLS davanti al pannello e digli dietro quanti proxy si trova:

```bash
RUNPANEL_TRUSTED_PROXY_HOPS=1
```

Il pannello legge l'indirizzo del client da `X-Forwarded-For` contando i proxy da destra, perché la prima voce la sceglie il client. Con `0` non si fida di nessun indirizzo, e i tentativi di accesso sono limitati solo in totale (20 ogni 15 minuti) e per account (10). Con un proxy configurato si aggiunge un limite per indirizzo (5), e il pannello può suggerire il tuo indirizzo nelle [regole di rete](network.md).

Nelle build di produzione il cookie di sessione è `Secure`, quindi funziona solo su HTTPS o su localhost, e il pannello invia HSTS. L'indirizzo con cui il pannello si presenta (link nelle notifiche, webhook) si imposta in **Impostazioni › Pannello › Indirizzo pubblico**: vedi [Automazione](automation.md).
