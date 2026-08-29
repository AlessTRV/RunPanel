[← RunPanel](../../README.md) · **Italiano** · [English](../en/databases.md)

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

**L'host dipende da chi si collega**, e il pannello mostra la riga giusta per
ognuno: un container sulla rete del progetto raggiunge il servizio per nome del
container e sulla porta *interna*; tutto il resto — un processo PM2, un container
su bridge, il tuo `psql` — passa dalla porta pubblicata sull'host.

Un servizio può anche essere **autonomo**, senza progetto: allora non inietta
niente e resta un database che gestisci dal pannello.

## I database dentro un servizio

Un server di database ne ospita più d'uno. La pagina del servizio li elenca
leggendoli dal motore, non da una lista del pannello, e permette di crearli ed
eliminarli con la connection URL pronta per ognuno.
