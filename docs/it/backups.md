[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/backups.md)

---

# Backup e ripristino

Una *policy* dice cosa salvare, dove, ogni quanto e quanti archivi tenere. Policy, destinazioni, archivi e ripristini appartengono al server su cui stanno: con [più server](multi-server.md) ognuno ha i propri, e un archivio si decifra solo con la chiave del server che l'ha preso.

Chi non è proprietario salva e ripristina solo i progetti e i servizi che gestisce, uno alla volta (vedi [Utenti e permessi](users.md)).

## Cosa si può salvare

| Target | Cosa comprende |
|---|---|
| Un servizio | il dump per intero (`pg_dumpall`, ruoli compresi, per Postgres) o dei database che scegli |
| Tutti i servizi | anche quelli che creerai dopo |
| Un progetto | a scelta: configurazione, volumi Docker, repository |
| Tutti i progetti | stesso criterio, anche quelli futuri |
| Il pannello | lo store di RunPanel, con o senza la chiave di cifratura |

Ogni dump gira **dentro il container a cui appartiene**, così client e server sono della stessa versione. Lo store SQLite del pannello viene catturato con `VACUUM INTO` e verificato con `PRAGMA integrity_check`; lo store Postgres con un `pg_dump` in formato custom, in un container della stessa major.

Un progetto caricato da ZIP include sempre il repository. La copia del repository salta `node_modules`, `.next`, `dist`, `build`, `vendor`, `.venv` e simili, e il `.env` scritto dal pannello.

## I volumi dei progetti

Con **volumi Docker** tra le cose da salvare, un progetto porta nell'archivio ogni suo volume (`projects/<slug>/volumes/<volume>.tar.gz`):

- quelli creati da RunPanel con l'etichetta `runpanel.project=<slug>`, per esempio il volume di un database collegato;
- quelli dello **stack Compose** del progetto, riconosciuti dal nome di progetto Compose `runpanel-<slug>` esatto (`runpanel-shop` non prende i volumi di `runpanel-shop2`).

Un volume `external: true` non appartiene allo stack e non entra nel backup: va salvato a parte. Il log elenca i volumi trovati per ogni progetto; se Docker non risponde, il progetto compare come saltato con il motivo.

### Coerenza della copia

Copiare un volume mentre l'app ci scrive può dare un database che si ripristina senza errori ed è rotto. Nella scheda **Impostazioni** del progetto, sezione **Backup dei volumi**, si sceglie cosa succede durante la copia:

| Modalità | Cosa fa |
|---|---|
| **Metti in pausa chi scrive** (predefinita) | `docker pause` sui soli container del progetto che montano il volume in scrittura, per il solo tempo della lettura. La copia equivale a un'interruzione di corrente, da cui SQLite (anche in WAL) e Postgres ripartono da soli. |
| **Copia a caldo** | Nessuna pausa. La copia può essere incoerente, e log e manifest lo dicono. |

Per tenere breve la pausa, il volume viene scritto su disco non compresso e compresso dopo, a container ripresi. Se lo spazio libero (oltre una riserva di 2 GB) non basta, si comprime durante la pausa al livello più veloce; se nemmeno così ci sta, il volume viene rifiutato prima di fermare qualcosa. Una pausa oltre i 10 minuti viene interrotta, i container ripresi e il volume segnato come non salvato. I container in sola lettura non si fermano; un container di un altro progetto che scrive nello stesso volume non viene toccato e la copia viene segnata come non garantita.

Se il pannello si ferma durante una pausa, i container vengono ripresi al riavvio o al backup successivo. Un container in pausa non genera notifiche di crash.

**Comando prima del backup.** Per i progetti Compose, un comando da eseguire una volta per backup in un servizio dello stack, prima di copiare i volumi (`sh -c`, timeout da 5 a 3600 secondi): per esempio un `.backup` di SQLite o un `pg_dump` dentro il volume. Se fallisce con la pausa attiva, il backup prosegue; se fallisce con la copia a caldo e qualcuno scrive, il volume non viene salvato.

### Esclusioni

Sempre da **Backup dei volumi**, per ogni volume si escludono percorsi relativi alla sua radice, uno per riga: `trades` esclude quella cartella e il suo contenuto, non `reports/trades`. Niente `..`, niente `/` iniziale, niente caratteri jolly. Il log (in italiano) riporta ogni esclusione con la sua dimensione, o "non presente nel volume":

```
→ memebot: volume runpanel-memebot_memebot-data
  esclusi: trades (492 MB)
  in pausa: memebot-record, memebot-label, memebot-telegram
  ripresi dopo 8,4 s di pausa
```

## Dove finiscono

- **Disco locale**: sempre `data/backups/archives/<anno>/<mese>`, file 0600. Creato al primo avvio ed è la destinazione predefinita; il percorso non si cambia.
- **S3-compatibile**: AWS S3, Cloudflare R2, MinIO, Backblaze B2. Endpoint, regione, bucket, chiavi, prefisso facoltativo e indirizzamento path-style; configurazione cifrata. `https://` ovunque, `http://` solo verso un indirizzo privato. **Verifica** scrive e cancella un oggetto di prova. L'oggetto si chiama `<prefisso>/<file>`, caricato in un'unica richiesta: su AWS vale il limite di 5 GB per oggetto.

Ogni archivio viene costruito prima in `data/backups/staging`, anche per S3: serve spazio libero in locale, e il backup si interrompe se scende sotto 2 GB.

L'archivio è uno zip con `manifest.json`, `LEGGIMI.txt` e `checksums.txt` in formato `sha256sum -c` (per i dump e i volumi; i file del repository non sono elencati). Le variabili dei progetti e le credenziali dei servizi sono cifrate con la chiave di questo server; includere la chiave stessa è una scelta esplicita a parte.

## Pianificazione e retention

- **Pianificazione**: cron a cinque campi o `@daily` e simili, nel fuso scelto (di default quello del pannello). Vuoto vuol dire **Solo su richiesta**. Non sono supportati secondi, `L`, `W`, `#` e `@reboot`.
- **Un backup alla volta**, e nessuno durante un ripristino. Un'esecuzione pianificata che trova il sistema occupato viene saltata, non accodata. Un'esecuzione persa a pannello spento viene recuperata solo entro il doppio dell'intervallo, o 24 ore se di più.
- **Retention**: numero (1–1000), età (1–3650 giorni) e dimensione totale (almeno 1 MB), insieme. Viene applicata dopo un'esecuzione riuscita, e l'archivio valido più recente non viene mai tolto.

## Ripristino

Un archivio su S3 viene prima scaricato nella cartella di lavoro del ripristino (serve lo spazio libero, più la riserva di 2 GB) e cancellato alla fine. Il ripristino mostra il contenuto dell'archivio: scegli le voci (solo quelle salvate con successo) e, per ognuna, dove ripristinarla: lo stesso servizio o progetto, oppure un altro dello stesso tipo. Per confermare si scrive il nome della prima destinazione.

Prima di sovrascrivere, il pannello prende un **backup di sicurezza** delle destinazioni sul disco locale (etichetta "Sicurezza pre-ripristino", mai tolto dalla retention, si cancella a mano). Se fallisce il ripristino si ferma, a meno che tu non abbia spuntato **Procedi anche senza backup di sicurezza**.

- **Volume**: il progetto si ferma; i suoi container rimasti accesi vengono fermati e riavviati alla fine, mentre un container di un altro progetto che usa il volume blocca il ripristino. I percorsi esclusi restano come sono. Un volume Compose che non esiste più si ricrea con un deploy, poi si ripete il ripristino.
- **Repository**: i file vengono sovrascritti, quelli in più non vengono cancellati.
- **Configurazione di un progetto**: il progetto deve esistere ancora.
- **Store del pannello (SQLite)**: non viene ripristinato a caldo. Il database viene messo da parte ed entra in servizio al riavvio successivo, con il precedente conservato accanto. La chiave di cifratura non viene rimessa: se serve, va copiata a mano.
- **Store del pannello (Postgres)**: il pannello rifiuta; il comando `pg_restore` da eseguire a pannello fermo è nel `manifest.json`.

Il ripristino non confronta le versioni dei motori: un dump di una major ripristinato su un'altra viene accettato e fallisce a metà, con il backup di sicurezza già preso.
