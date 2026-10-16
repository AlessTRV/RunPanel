[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/operations.md)

---

# Operatività

Tutto quello che segue riguarda il server selezionato nella barra: con [più server](multi-server.md) ognuno ha il proprio avvio automatico, la propria pulizia e il proprio aggiornamento.

## Avvio automatico

**Sistema › Avvio automatico** dice cosa la macchina fa già al boot e genera quello che manca:

- una **unit systemd** con percorsi assoluti, dopo `docker.service` e dipendente da esso. Se il pannello gira da root la installa, altrimenti mostra un blocco da incollare;
- dove systemd non c'è, uno **script `@reboot`** supervisionato, che il pannello aggiunge al crontab dell'utente da solo. Il suo output va in `logs/autostart.log`.

Il pannello non esegue mai `systemctl start`, che metterebbe un secondo pannello sulla stessa porta. La unit ha `KillMode=process`, così `systemctl stop runpanel` non ferma PM2 né le app native che supervisiona; i container Docker non sono coinvolti.

La pagina controlla anche ciò che serve davvero al riavvio: Docker abilitato all'avvio (pulsante **Abilita**) e la lista di PM2 salvata (pulsante **pm2 save**), quando PM2 fa girare almeno un'app. Senza, dopo un riavvio il pannello torna e le app no.

Ogni progetto e servizio ha un interruttore, un ordine, un ritardo e se aspettare che sia pronto prima di passare al successivo, al massimo un minuto: un servizio quando il motore risponde, un progetto quando passa l'health check del suo ultimo deploy (o, con l'health check spento, quando il processo è acceso). Di default i servizi ripartono e vengono attesi, i progetti no; i servizi partono sempre prima dei progetti. Al boot il pannello aspetta 20 secondi che Docker riavvii da sé quello che sa, poi avvia solo quello che è ancora giù, a 2 secondi di distanza, senza mai lanciare un build. **Simula** mostra cosa farebbe, **Esegui ora** lo fa subito.

Lo stato negli elenchi viene ricontrollato ogni mezzo minuto e dopo la riconciliazione: un progetto può passare a **Fermo** senza che nessuno l'abbia spento in quel momento, vuol dire che era già giù. Il controllo non avvia né ferma niente, e per segnare fermo qualcosa che risultava acceso vuole due letture d'accordo.

## Riavvio programmato

La sezione **Riavvio programmato** sta nelle impostazioni del progetto e nella pagina del servizio. Si sceglie un intervallo pronto (ogni notte alle 04:00, ogni domenica, ogni 6 ore, ogni ora) o un'espressione cron a cinque campi, con l'anteprima dei prossimi tre riavvii.

L'ora è nel **fuso orario del pannello** (**Impostazioni › Pannello**, lo stesso dei backup); finché non lo imposti è UTC, e la pagina lo dice. Cambiarlo ricalcola subito i riavvii in attesa.

Al momento stabilito:

- **In esecuzione**: lo riavvia. Un progetto riparte dall'ultimo deploy riuscito, con le variabili dei servizi collegati.
- **Fermato da te**: lo lascia fermo.
- **Caduto da solo**: fa **un solo tentativo** di rimetterlo su, e ci riprova solo se torna su e cade di nuovo.
- **Deploy in corso** o **ultimo deploy fallito**: lo salta.

La pagina mostra l'ultima occorrenza e cosa ha fatto. Se il pannello era spento all'ora prevista, il riavvio avviene una volta sola appena torna su, anche se nel frattempo ne sono saltati più d'uno. Con le notifiche attive arriva un messaggio per ogni riavvio eseguito o fallito, non per i salti.

## Liberare spazio

**Sistema › Pulizia Docker** mostra quanto occupa Docker e cosa si può recuperare. **Pulisci ora** toglie solo ciò che si può ricreare, mai volumi o dati:

- le versioni vecchie delle immagini dei progetti, oltre quelle tenute per il rollback (2 per progetto di default);
- le immagini senza nome che nessun container usa, avanzi delle build compreso compose;
- container, immagini e reti orfani di RunPanel, comprese le immagini compose di un progetto eliminato;
- la cache di build: tutta, oppure solo quella più vecchia di una settimana. Tutta libera più spazio, ma il prossimo build di ogni progetto riparte da zero.

Un'opzione spenta di default toglie **tutte le immagini che nessun container usa**, anche quelle non create da RunPanel (database vecchi, immagini di base, altri progetti Docker). Si riscaricano quando servono, ma un'immagine costruita a mano e mai pubblicata andrebbe persa: per questo chiede conferma. Le versioni tenute per il rollback restano.

Il totale liberato è misurato sull'occupazione di Docker prima e dopo. I volumi orfani si tolgono solo dal riquadro **Risorse orfane**, perché contengono dati.

Ogni 6 ore il pannello fa da sé la parte sicura: applica la retention delle immagini, toglie le proprie immagini senza nome e la cache di build più vecchia di una settimana. Eliminare un progetto Compose toglie anche le immagini che compose ha costruito, e ogni container avviato dal pannello ha il log limitato a tre file da 10 MB (dal deploy o dalla ricreazione successivi; per Compose decide il tuo file).

## Aggiornare il pannello

RunPanel gira da un clone git del suo repository. La versione mostrata è `v0.1.0+125`, dove il numero è il conteggio dei commit sul ramo principale (su un clone shallow, lo SHA). A intervalli (1, 6 o 24 ore, si sceglie nella pagina) fa un `git fetch` e confronta; per un repository privato usa il token GitHub del pannello. **Non applica mai niente da solo**: quando il branch si è mosso compare una striscia in cima alle pagine con il pulsante **Aggiorna**, e **Sistema › Aggiornamenti** elenca i commit. Con più server, striscia e pagina seguono il server selezionato: per aggiornare un nodo, selezionalo.

Premuto **Aggiorna**, il pannello:

1. scarica i commit e, se l'hai attivata, verifica la firma;
2. copia lo store SQLite con `VACUUM INTO` (uno store Postgres non viene copiato);
3. allinea il checkout con `git reset --hard` e `git clean -fd`: le modifiche locali non committate si perdono, mentre i file ignorati (`data/`, `node_modules/`, `.next`) e i `.env*` restano, e il log elenca cosa viene rimosso;
4. installa le dipendenze e costruisce la nuova versione in `.next-update`, senza toccare quella in uso;
5. scambia le cartelle con due rename (la vecchia va in `.next-old`) ed esce con codice 75: a rimetterlo su pensa systemd (`Restart=always`) o lo script `@reboot`.

Un minuto dopo il riavvio riuscito, `.next-old` e la copia dello store vengono cancellati. Se qualcosa fallisce prima dello scambio, checkout e dipendenze tornano come prima e il pannello continua a girare sulla versione di prima.

L'aggiornamento viene rifiutato se il pannello non è un clone git con un remote `origin` https o ssh, se HEAD è staccato, se gira in modalità di sviluppo, in un container o su Windows, se ci sono meno di 2 GB liberi, o se è in corso un deploy, un backup o un ripristino (controllato anche dopo il build). Senza un supervisore il pulsante diventa **Prepara**: la nuova versione viene costruita, ma lo scambio e il riavvio restano due comandi da eseguire a mano.

**Firma dei commit.** Facoltativa e spenta di default: nella pagina Aggiornamenti si può richiedere che i commit siano firmati da chiavi GPG o SSH ammesse (**Firmatari ammessi**, per SSH).

Se il pannello non tornasse su, i comandi per rimettere la versione precedente sono in `<dataDir>/panel-update.json` e nel log del supervisore (journal di systemd, o `logs/autostart.log` con lo script).

## Notifiche su Telegram

Si configurano in **Impostazioni › Pannello**, sezione **Notifiche Telegram** (serve il permesso Notifiche): crei un bot con `@BotFather`, incolli il token, scrivi un messaggio al bot e premi **Rileva** per scegliere la chat. Il pannello parla solo in uscita, quindi non serve che sia raggiungibile; in cambio il bot non accetta comandi. Il token è cifrato e la pagina sa solo se c'è.

In un [cluster](multi-server.md) bot e chat sono condivisi da tutti i server; quali eventi inviare resta per server.

### Cosa viene notificato

| Evento | Quando |
|---|---|
| **Un progetto si è fermato da solo**, **Un servizio si è fermato da solo** | Il processo non c'è più e non l'ha fermato il pannello (due interruttori separati, conferma su due letture) |
| **Riavvio programmato** | Un riavvio programmato eseguito, o il tentativo dopo un crash fallito |
| **Docker non risponde** | Il daemon diventa irraggiungibile, e quando torna (non se era già giù all'avvio del pannello) |
| **Deploy concluso** | Sempre per i deploy automatici; per quelli manuali solo se falliscono |
| **Backup concluso** | Riuscito, parziale o fallito, con artefatti, dimensione e durata |
| **Aggiornamento del pannello disponibile** | Il controllo ha trovato commit nuovi |
| **Il pannello è ripartito** | Dopo un riavvio o un aggiornamento; spento di default |
| **Spazio su disco in esaurimento** | Vedi sotto |

Ogni voce ha il suo interruttore; tutte sono accese di default tranne il riavvio del pannello.

Viene notificato il momento in cui una soglia viene attraversata, non lo stato. Crash, Docker e disco hanno in più un silenzio di quindici minuti per evento e per soggetto, così un progetto che continua a cadere non copre un altro. L'aggiornamento è annunciato quando cambia il commit di destinazione.

### Lo spazio su disco

- **Basso**: sotto il 10% o i 4 GB liberi, o sotto il 5% degli inode. Funziona ancora tutto, ma il prossimo build o la copia di un volume grande possono riempire il resto.
- **Critico**: sotto i 2 GB (la riserva sotto cui un backup non parte), sotto il 3%, o sotto il 2% degli inode. Backup rifiutati, build che falliscono, database che non scrivono.

Il controllo gira ogni cinque minuti, il primo 90 secondi dopo l'avvio, sul disco dei dati e, se è un altro, su quello di Docker. Ogni policy di backup pianificata viene confrontata con lo spazio che le servirà (il doppio dell'ultimo archivio più la riserva): se non ci sta, l'avviso arriva prima dell'esecuzione. Le soglie hanno un margine prima di dirsi rientrate, e il rientro viene notificato.

### Se la notifica non parte

Non si blocca niente: un deploy non fallisce perché Telegram non risponde. L'errore finisce nel log del pannello, spiegato dove Telegram è criptico: `chat not found` di solito vuol dire che non hai ancora scritto al bot.
