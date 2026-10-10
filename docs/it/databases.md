[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/databases.md)

---

# Database e servizi

Un *servizio* è un database gestito dal pannello: un container etichettato, con
il proprio volume nominato e le credenziali cifrate.

| Motore | Versioni offerte |
|---|---|
| PostgreSQL | 18, 17, 16, 15, 14 |
| MySQL | 9, 8 |
| Redis | 8, 7, 6 |
| MongoDB | 8.0, 7.0 |

Sono le major che l'immagine ufficiale supporta oggi, meno i canali di anteprima
e quelli a cadenza breve. Un servizio già esistente non viene toccato quando
l'elenco cambia: la versione è salvata per riga e le ricreazioni usano quella.

## La console

Il pannello sa già nome del container, utente e password — le tre cose che
andresti a cercare prima di scrivere `docker exec` sull'host. La console le usa
al posto tuo, in tre modalità: il **client del motore** già autenticato
(`psql`, `mysql`, `redis-cli`, `mongosh`), una **shell** dentro il container, e
il **log** del container in diretta. Il log è in sola lettura e non viene
salvato da nessuna parte: esiste finché lo guardi.

Non è un emulatore di terminale: `docker exec` con lo standard input in pipe non
può allocare un TTY, quindi si manda una riga alla volta. Per questo i flag
contano — senza `--table` MySQL risponde in colonne separate da tabulazioni, e
senza `--force` il primo errore di sintassi chiuderebbe la sessione.

Prima della prima sessione c'è un avviso, e va accettato: da lì si cancellano
dati in modo irreversibile, e il pannello non tiene una copia.

## Cartelle condivise con l'host

Una cartella qualsiasi del container può comparire dove vuoi tu sull'host: la
configurazione, i log, gli upload, la directory dati. Più di una, ognuna
accendibile, spegnibile e in sola lettura. Vale per i servizi e per i progetti
con runtime Docker, con la stessa interfaccia.

**La prima volta il pannello semina**, ed è la parte che conta. Un bind non è una
sincronizzazione ma una **sostituzione**: la cartella dell'host copre quel
percorso dentro il container, quindi senza semina vedresti una cartella vuota — e
il servizio pure. Il pannello copia fuori il contenuto attuale prima di montare;
da lì in poi è la stessa cartella, sottocartelle comprese, senza riavviare.

La semina va a due velocità. Una cartella qualunque è una copia. La **directory
dati del motore** è l'unico caso in cui sbagliare non si vede: `cp` senza `-a`
perde proprietario e permessi, e un Postgres che si trova davanti una cartella
vuota si inizializza da capo, funziona benissimo e ha perso tutto. Quel caso
ferma il servizio, copia conservando i permessi, ricrea, **chiede al motore se i
database ci sono ancora** e se non ci sono rimette tutto com'era da solo.

Se la cartella dell'host non è vuota si ferma e lo dice, con una casella per
adottare quello che c'è già senza copiarci sopra. E togliere un bind dalla
directory dati viene rifiutato finché non lo confermi: il motore tornerebbe sul
volume di prima, fermo a com'era quando l'avevi aggiunto, e ripartirebbe su dati
più vecchi senza dire niente.

## Dove stanno i file di un progetto nativo

Un progetto sotto PM2 non ha un container, quindi non ha bind: ha una cartella.
Dalle impostazioni la si sposta su un altro disco, con tutto dentro —
`node_modules` e build compresi, così riparte senza ricostruire.

Al vecchio posto resta un **collegamento**: molti punti del pannello costruiscono
`data/repos/<slug>` dal solo slug, e i percorsi assoluti già salvati puntano lì
dentro. Il collegamento li fa risolvere tutti senza toccarne nessuno. La copia di
partenza non viene cancellata: resta finché non lo dici tu.

## Il collegamento a un progetto

Un servizio può essere collegato a un progetto, e allora gli fornisce la propria
connection URL in una variabile d'ambiente. Il collegamento ha un **interruttore
esplicito**:

- **Acceso**, il valore iniettato vince su una variabile che avessi definito a
  mano, e il pannello lo scrive nel log del deploy.
- **Spento**, il progetto usa le proprie variabili e il pannello non tocca niente.

La variabile ha un nome modificabile (`DATABASE_URL` per default, derivato dal
tipo). Due collegamenti attivi nello stesso progetto non possono rispondere alla
stessa chiave: il secondo viene rifiutato nominando il primo e proponendo un nome
alternativo, invece di sovrascriverlo in silenzio.

**L'host dipende dal runtime del progetto**, e il pannello lo decide da solo:

- un progetto **Docker** o **Compose** riceve il nome del container e la porta
  *interna* (`runpanel-svc-<slug>-<nome>:5432`), perché RunPanel aggancia l'app
  alla rete `runpanel-net-<slug>` a ogni deploy. Un container Docker ci viene
  messo all'avvio; uno stack Compose riceve un file di override generato accanto
  ai dati del pannello — il compose del repository non viene toccato — che
  aggiunge la rete a ogni servizio dello stack. Un servizio con `network_mode`
  non può essere agganciato e il log del deploy lo dice;
- un progetto **nativo** (Node.js, Python, Custom sotto PM2) riceve `localhost`
  e la porta pubblicata, perché gira sull'host. Lo stesso vale per un container
  su `network: host`.

Dentro un container `localhost` è il container stesso, e `host.docker.internal`
passa dal firewall dell'host, che può bloccarlo: è per questo che i progetti a
container usano la rete e non la porta pubblicata. La pagina del servizio mostra
la riga per ogni punto di vista e dice quale delle due viene iniettata; la scheda
Variabili del progetto scrive, sotto la variabile, l'host che arriverà all'app;
e il log del deploy stampa la URL iniettata con la password mascherata.

Un servizio può anche essere **autonomo**, senza progetto: allora non inietta
niente e resta un database che gestisci dal pannello.

**Eliminare il progetto non elimina i suoi servizi.** Restano come servizi
autonomi, container e dati compresi, nella cartella in cui stava il progetto. Il
pannello di eliminazione li elenca: ognuno si elimina da solo, scegliendo se
tenere il volume, e una spunta — spenta di default — li porta via tutti insieme
al progetto, volumi inclusi. L'app da sola si rimuove con «Rimuovi app», che
lascia progetto e servizi al loro posto.

## Rinominare un servizio

Il pulsante **Rinomina** sulla pagina del servizio cambia il nome che il pannello
mostra, subito e ovunque: liste, notifiche, backup. Come per lo slug di un
progetto, il **nome tecnico** scelto alla creazione invece non cambia mai: è nel
nome del volume dei dati (`runpanel-postgres-<slug>-<nome>`), e Docker non sa
rinominare un volume. Un nome tecnico diverso farebbe ripartire il database su un
volume nuovo e vuoto.

Il **container** segue il nome nuovo al **prossimo deploy del progetto** a cui il
servizio è collegato, deploy o rebuild. È il momento in cui l'app riparte
comunque, ed è quello in cui riceve il nuovo host nella connection URL. Il
database si riavvia per qualche secondo, sui volumi che aveva; il vecchio nome
del container resta un alias sulla rete del progetto, così l'app ancora accesa
dal deploy precedente, o rimasta accesa da un deploy fallito più avanti, continua
a raggiungerlo. Il log del deploy dice cosa è stato rinominato e dove stanno i
dati. Se il nome nuovo è già di un altro container, il rinomina viene saltato e
il log lo spiega. La pagina del servizio mostra il nome che il container prenderà
finché il deploy non arriva.

Un servizio autonomo cambia solo il nome mostrato: non c'è un deploy che lo
riavvii. Lo stesso principio vale per ogni ricreazione (cambio dell'accesso,
delle cartelle condivise): il container riparte sul volume che ha davvero, letto
da Docker, anche dopo uno spostamento in un altro progetto.

## I database dentro un servizio

Un server di database ne ospita più d'uno. La pagina del servizio li elenca
leggendoli dal motore, non da una lista del pannello, e permette di crearli ed
eliminarli con la connection URL pronta per ognuno.
