[← RunPanel](../../README.md) · **Italiano** · [English](../en/configuration.md)

---

# Configurazione

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

## Lo store: SQLite o Postgres

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

## Registri privati

Le credenziali dei registri Docker si inseriscono dal pannello, sono cifrate a
riposo e riscritte nella configurazione di Docker all'avvio — la directory dei
dati può sopravvivere a una ricostruzione del container, e un file di
autenticazione mancante si manifesta come un `pull access denied` che non dice
niente di utile.

## Metterlo su internet

Termina il TLS davanti al pannello e digli dietro quanti proxy si trova:

```bash
RUNPANEL_TRUSTED_PROXY_HOPS=1
```

Senza, il pannello non può credere a nessun indirizzo del client —
`X-Forwarded-For` viene esteso da ogni hop, quindi la prima voce è quella scelta
dal client — e ripiega su un unico limite di accesso valido per tutto l'account.
Il cookie di sessione è marcato `Secure` nelle build di produzione, e i browser
lo accettano solo su HTTPS o su localhost.
