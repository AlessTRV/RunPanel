[← RunPanel](../../README.md) · **Italiano** · [English](../en/backups.md)

---

# Backup e ripristino

Una *policy* dice cosa salvare, ogni quanto, e quanto tenerne.

## Cosa si può salvare

| Target | Cosa comprende |
|---|---|
| Un servizio | il dump del database, per intero o di un singolo database |
| Tutti i servizi | selettore: comprende quelli che creerai domani |
| Un progetto | configurazione, volumi, repository — a scelta |
| Tutti i progetti | stesso criterio |
| Il pannello | lo store di RunPanel, con o senza la chiave di cifratura |

I target sono selettori invece che elenchi fissi, così «ogni database» continua a
significare quelli che esistono quando il backup parte.

## Come vengono presi

Ogni dump gira **dentro il container a cui appartiene**, così client e server
sono sempre della stessa versione. Lo store SQLite di RunPanel viene catturato
con `VACUUM INTO` e poi verificato con `PRAGMA integrity_check`, mai copiato.

## Dove finiscono

- **Disco locale** — `data/backups/archives/<anno>/<mese>`, con permessi 0600.
- **S3-compatibile** — AWS S3, Cloudflare R2, MinIO, Backblaze B2. La firma è
  SigV4 calcolata in casa, senza SDK. L'endpoint accetta `https://` ovunque e
  `http://` solo verso un indirizzo privato: un archivio contiene ogni variabile
  d'ambiente del pannello.

L'archivio è un normale zip con un `manifest.json` e un `checksums.txt` in
formato `sha256sum -c`, così si può verificare e spacchettare senza RunPanel. Le
variabili d'ambiente e le credenziali dei servizi al suo interno sono ricifrate
con la chiave di questo pannello; includere la chiave stessa è una scelta a
parte, ed esplicita.

## Pianificazione, retention, ripristino

| | |
|---|---|
| Pianificazione | cron a cinque campi più la famiglia `@daily`, nel fuso che scegli |
| Retention | numero, età e dimensione totale, insieme — l'archivio valido più recente non viene mai raccolto |
| Ripristino | guidato, con un backup automatico pre-ripristino che interrompe il ripristino se fallisce |

Il ripristino mostra il contenuto dell'archivio e ti fa scegliere voce per voce.
Lo store del pannello è l'unica cosa che non viene ripristinata a caldo: il
database ripristinato viene messo da parte ed entra in servizio al riavvio
successivo, con il precedente conservato accanto.
