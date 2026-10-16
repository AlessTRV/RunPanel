[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/databases.md)

---

# Database e servizi

Un *servizio* è un database gestito dal pannello: un container etichettato, con il proprio volume e le credenziali cifrate. Vive sul server su cui è stato creato (con [più server](multi-server.md), quello selezionato nella barra).

| Motore | Versioni offerte | Porta di default | Variabile di default |
|---|---|---|---|
| PostgreSQL | 18, 17, 16, 15, 14 | 5432 | `DATABASE_URL` |
| MySQL | 9, 8 | 3306 | `DATABASE_URL` |
| Redis | 8, 7, 6 | 6379 | `REDIS_URL` |
| MongoDB | 8.0, 7.0 | 27017 | `MONGODB_URL` |

Le versioni sono le major supportate dall'immagine ufficiale. La versione è salvata per servizio: quando l'elenco cambia, un servizio esistente non viene toccato.

Alla creazione utente e database sono `runpanel` e `runpanel_db`, con una password casuale; si possono cambiare. Redis ha solo una password. Vedere le credenziali richiede il livello Gestione sul servizio.

La porta viene pubblicata su tutte le interfacce. Per limitarla a certi indirizzi, già alla creazione o dopo, vedi [Accesso di rete](network.md).

## La console

Tre modalità: **Motore** (il client già autenticato: `psql`, `mysql`, `redis-cli`, `mongosh`), **Shell** dentro il container e **Log** del container in diretta.

- Motore e Shell richiedono il servizio acceso e il permesso del terminale sul servizio; a ogni apertura della pagina c'è un avviso da accettare, perché da lì si cancellano dati senza copia.
- Il Log mostra le ultime 200 righe, funziona anche a servizio fermo e non viene salvato.
- Una sessione per persona e per servizio, chiusa dopo 10 minuti di inattività.
- Non è un terminale completo: si manda una riga alla volta.

## I database dentro un servizio

Nella scheda **Database** un server ne ospita più d'uno: si creano e si eliminano, ognuno con la sua connection URL. L'elenco unisce quello che riporta il motore con quello che conosce il pannello, e segnala i database creati fuori dal pannello e quelli che il motore non ha più.

- Nomi in minuscolo, cifre e trattino basso, al massimo 63 caratteri.
- I database di sistema non si eliminano; quello principale se ne va solo eliminando il servizio. Un database Postgres con connessioni aperte viene rifiutato invece di essere chiuso a forza.
- Redis non ha database con nome: la pagina spiega come usare `/0`, `/1` e così via.

## Il collegamento a un progetto

Un servizio collegato a un progetto gli fornisce la propria connection URL in una variabile d'ambiente. Il collegamento si fa alla creazione o dopo, e si può staccare o spostare su un altro progetto. La variabile arriva all'app al deploy successivo e a ogni riavvio.

Un **interruttore** decide se iniettarla:

- **acceso**: il valore iniettato vince su una variabile con lo stesso nome definita a mano, e il log del deploy lo dice;
- **spento**: il progetto usa le proprie variabili.

Il nome della variabile si può cambiare. Se due servizi dello stesso progetto userebbero lo stesso nome, alla creazione il secondo prende `<NOME>_DATABASE_URL`; modificando un collegamento esistente, il pannello rifiuta e propone un nome libero.

**L'host dipende dal runtime del progetto:**

- un progetto **Docker** o **Compose** riceve il nome del container e la porta *interna* (`runpanel-svc-<slug>-<nome>:5432`), perché RunPanel aggancia l'app alla rete `runpanel-net-<slug>` a ogni deploy. Per Compose genera un file di override accanto ai dati del pannello, senza toccare il compose del repository; un servizio con `network_mode` non può essere agganciato e il log lo dice;
- un progetto **nativo** (sotto PM2) o un container su `network: host` riceve `localhost` e la porta pubblicata.

La pagina del servizio mostra la URL per ogni punto di vista e quale viene iniettata, la scheda **Variabili** del progetto mostra l'host che arriverà all'app, e il log del deploy stampa la URL con la password mascherata.

Un servizio può anche essere **autonomo**, senza progetto: non inietta niente.

**Eliminare il progetto non elimina i suoi servizi.** Restano autonomi, con container e dati, nella cartella del progetto. La finestra di eliminazione li elenca: ognuno si elimina a parte scegliendo se tenere il volume, oppure una spunta (spenta di default) li elimina tutti con il progetto, volumi compresi. **Rimuovi app** toglie solo l'app e lascia progetto e servizi.

## Cartelle condivise con l'host

Una cartella del container può comparire dove vuoi sull'host: configurazione, log, upload, la directory dati. Se ne possono aggiungere più d'una, ognuna attivabile e, se serve, in sola lettura. Vale per i servizi e per i progetti Docker, con la stessa interfaccia, e richiede il permesso **Accesso all'host**.

Un bind **sostituisce** la cartella del container. Per questo, la prima volta, il pannello **semina**: ferma il servizio, copia il contenuto attuale sull'host conservando proprietari e permessi, e ricrea il container. Per la **directory dati del motore** controlla anche, prima e dopo, che i database ci siano ancora. Se qualcosa va storto, torna da solo alla configurazione precedente; se il pannello si spegne a metà, al riavvio ricostruisce l'ultima configurazione funzionante.

- Se la cartella dell'host non è vuota il pannello si ferma e lo dice, con una casella per adottarne il contenuto senza copiarci sopra.
- Sono rifiutati: la directory dati in sola lettura, due bind sullo stesso percorso del container, la cartella dei dati del pannello o una che la contiene, e una copia senza almeno il 5% di spazio libero in più.
- Togliere il bind della directory dati va confermato: il motore tornerebbe al volume di prima, fermo a quando avevi aggiunto il bind.

## Rinominare un servizio

**Rinomina** cambia subito il nome mostrato ovunque: liste, notifiche, backup. Il **nome tecnico** scelto alla creazione non cambia mai, perché è nel nome del volume (per esempio `runpanel-pg-<slug>-<nome>`; `mysql`, `redis` e `mongo` per gli altri motori; senza `<slug>` per un servizio autonomo) e Docker non rinomina i volumi.

Il **container** prende il nome nuovo al prossimo deploy del progetto collegato. Il database si riavvia per qualche secondo sugli stessi volumi, e il vecchio nome resta un alias sulla rete del progetto, così l'app ancora accesa continua a raggiungerlo. Se il nome nuovo è già di un altro container il rinomina viene saltato e il log lo spiega. Un servizio autonomo cambia solo il nome mostrato.
