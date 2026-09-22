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

## I volumi dei progetti

Con **volumi Docker** tra le cose da salvare, un progetto porta nell'archivio
ogni suo volume, un file `projects/<slug>/volumes/<volume>.tar.gz` ciascuno. Vale
per un singolo progetto e per «tutti i progetti». I volumi sono di due tipi:

- quelli che RunPanel crea ed etichetta da sé (`runpanel.project=<slug>`), per
  esempio il volume di un database collegato al progetto;
- quelli creati dallo **stack Compose** del progetto. Compose non accetta
  etichette su `up`, quindi il riferimento è il nome di progetto Compose,
  `runpanel-<slug>`: un volume entra se `com.docker.compose.project` vale
  esattamente quello. `runpanel-shop` non prende mai i volumi di
  `runpanel-shop2`, e un volume senza etichette non entra mai.

Il log del backup elenca i volumi trovati per ogni progetto. Se Docker non
risponde, il progetto compare come elemento saltato con il motivo: una lista
vuota non passa più in silenzio per «nessun dato».

### Coerenza della copia

Copiare un volume mentre l'app ci scrive può produrre un database con i file
presi in momenti diversi, che si ripristina senza errori ed è rotto. Per questo,
in **Impostazioni → Backup dei volumi** di ogni progetto, si sceglie cosa
succede durante la copia:

| Modalità | Cosa fa |
|---|---|
| **Metti in pausa chi scrive** (predefinita) | `docker pause` sui soli container del progetto che montano quel volume in scrittura, per il solo tempo della lettura. La copia è *crash-consistent*: lo stato che lascerebbe un'interruzione di corrente, da cui SQLite (anche in WAL) e Postgres ripartono da soli. |
| **Copia a caldo** | Nessuna pausa. La copia può essere incoerente, e il log e il manifest lo dicono ogni volta. |

Il fermo è tenuto al minimo: durante la pausa il volume viene scritto su disco
**non compresso**, alla velocità del disco; la compressione avviene dopo, a
container ripresi. Solo se lo spazio libero (oltre la riserva di 2 GB) non basta
per quella copia più la sua versione compressa si comprime durante la pausa, che
allora dura di più, e il log lo dice. Una pausa che supera i 10 minuti viene
interrotta, i container ripresi, e il volume segnato come non salvato. I
container montati in sola lettura non vengono fermati; un container di un altro
progetto che scrive nello stesso volume non viene mai toccato, e la copia viene
segnata come non garantita.

Gli id dei container in pausa vengono annotati su disco
(`data/backups/paused-containers.json`) finché la pausa dura: se il pannello
muore a metà copia, all'avvio successivo — o al backup successivo — li riprende.
Un container in pausa non conta come caduto per il controllo di stato, quindi
un backup non genera notifiche di crash.

**Comando pre-backup.** Per i progetti Compose si può aggiungere un comando da
eseguire, una volta per backup, in un servizio dello stack prima di copiare i
volumi (`sh -c`, con un timeout): per esempio un `.backup` di SQLite o un
`pg_dump` dentro il volume. Se fallisce e la copia è in pausa, il backup prosegue
lo stesso; se la copia è a caldo il volume non viene salvato, perché senza né
comando né pausa niente la renderebbe coerente.

Il log dice cosa è successo, volume per volume:

```
→ memebot: volume runpanel-memebot_memebot-data
  esclusi: trades (492 MB)
  in pausa: memebot-record, memebot-label, memebot-telegram
  ripresi dopo 8,4 s di pausa
```

e il manifest lo registra nel `meta` dell'elemento: `consistency` (`result`
`paused`, `idle` o `live`, chi è stato messo in pausa, per quanti millisecondi,
chi no e perché, `method` `snapshot` o `stream`), `preBackup`, `excludes` ed
`excluded`.

### Esclusioni

Sempre da **Backup dei volumi**, per ogni volume si possono escludere dei
percorsi, uno per riga, relativi alla radice del volume: `trades` esclude la
cartella e tutto quello che contiene (e solo quella: `reports/trades` resta).
Niente `..`, niente `/` iniziale, niente caratteri jolly — così il percorso
scritto e quello che `tar` esclude sono la stessa cosa. Il log riporta ogni
esclusione con la sua dimensione, o «non presente nel volume» se non corrisponde
a niente, e il manifest le elenca.

### Ripristino di un volume

Il ripristino ferma il progetto, poi controlla che nessun container abbia
ancora il volume montato: quello che del progetto è rimasto acceso (uno stop di
Compose fallito, un servizio collegato) viene fermato e riavviato alla fine; un
container che non è del progetto blocca il ripristino, e il volume non viene
toccato. I percorsi esclusi dal backup restano **come sono**: l'archivio non li
contiene, quindi non li sovrascrive né li cancella. Un volume Compose che non
esiste più si ricrea con un deploy del progetto, poi si ripete il ripristino.

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
