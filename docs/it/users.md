[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/users.md)

---

# Utenti e permessi

Il pannello può avere più account. Il primo è il **proprietario**: lo crea il primo avvio, ha sempre tutti i permessi e nessuno può limitarlo, disattivarlo o eliminarlo. Ogni altro account nasce senza accessi e riceve solo quello che gli dai.

Con [più server](multi-server.md) gli account sono gli stessi ovunque e si gestiscono da qualunque pannello; sessioni e link di invito restano del pannello su cui nascono.

## Accedere

Si entra con email e password. Il pannello non invia email: l'email è solo il nome con cui accedi.

## Invitare qualcuno

In **Accessi › Utenti › Invita utente** scrivi l'email e scegli per quanto vale il link: 1 ora, 24 ore, 7 giorni o una durata a piacere fino a 30 giorni. Il pannello mostra il link **una volta sola** e lo mandi tu alla persona. Il link funziona una volta: la persona sceglie la password ed entra.

Dalla pagina di un account generi un link nuovo: un invito se l'account non ha ancora una password, altrimenti un link per sceglierne una nuova (così si risolve una password dimenticata). Ogni link nuovo annulla quelli non usati, e usarne uno disconnette quell'account da ogni dispositivo.

## Cosa può fare un account

### Progetti e servizi

Un accesso punta a **tutto**, a una **cartella**, a un **progetto** o a un **servizio**, con uno di tre livelli:

| Livello | Progetto | Servizio |
|---|---|---|
| Lettura | stato, log, storico dei deploy, nomi delle variabili con valori mascherati | stato |
| Operatore | in più deploy, avvio, stop, riavvio | in più avvio, stop, riavvio |
| Gestione | in più impostazioni, variabili in chiaro, file, mount, comandi una tantum, eliminazione | in più credenziali, database interni, mount, impostazioni, eliminazione |

L'interruttore **Terminale e console**, da Operatore in su, apre una shell nei container e la console dei database. Ogni persona ha la sua sessione.

Vale il livello più alto tra gli accessi che riguardano un elemento. Un accesso a una cartella vale anche per ciò che ci finisce dopo, e un servizio collegato a un progetto segue l'accesso del progetto. Non esistono regole di divieto: per togliere un accesso si toglie la riga. Chi non vede un progetto riceve "non trovato", come se non esistesse.

Con più server un accesso può puntare a un progetto o servizio di qualunque server: nell'editor ogni elemento ha accanto il nome del server.

### Permessi del pannello

Interruttori per account: Crea progetti e servizi, GitHub, Registry, Storage, Backup, Ripristino, Monitor, Avvio automatico, Diagnostica, Notifiche, Aggiornamenti, Accesso all'host, Gestione utenti, Registro attività, Server collegati. Menu e pulsanti li seguono, ma il controllo vero lo fa il server su ogni richiesta e su ogni stream.

Da dare con attenzione:

- **Accesso all'host.** Runtime nativi (PM2), Compose, cartelle condivise (anche sui servizi), cap Docker, rete host, comandi una tantum e modifica del codice di un progetto (file, upload, repository) escono dal container e arrivano fino al database del pannello e alla sua chiave segreta. Senza questo permesso, anche chi ha Gestione su un progetto lavora solo con container Docker semplici.
- **Backup e Ripristino.** Chi non è proprietario salva e ripristina solo i progetti e i servizi che gestisce, uno per uno. Il backup del pannello e quello con la chiave segreta restano al proprietario.
- **Gestione utenti.** Non permette di toccare il proprietario né sé stessi, di concedere un permesso o un livello che non si possiede, né di modificare, reimpostare o eliminare un account con più accessi dei propri.
- **Server collegati.** Collegare, diagnosticare, cambiare ruolo e revocare i server del cluster, e rigenerare il segreto condiviso. Non dà accesso ai progetti degli altri server, che seguono i permessi di sempre.

I **modelli rapidi** compilano i campi in un clic e poi si ritoccano:

| Modello | Permessi | Accesso |
|---|---|---|
| Visualizzatore | nessuno | Lettura su tutto |
| Sviluppatore | Crea progetti e servizi, GitHub | Operatore su tutto |
| Operatore sistema | Monitor, Storage, Backup, Avvio automatico, Diagnostica | Operatore su tutto |
| Nessun accesso | nessuno | nessuno |

### Chi ha accesso

Nelle impostazioni di un progetto o di un servizio, chi gestisce gli utenti vede gli account che lo raggiungono, con livello e provenienza dell'accesso, e da lì può cambiarli.

## Revoca

Togliere un accesso, disattivare o eliminare un account, chiudere una sessione: ha effetto subito, e gli stream e le shell aperti di quell'utente si chiudono. Disattivare un account lo disconnette da ogni dispositivo.

## Registro attività

**Accessi › Registro attività** elenca chi ha fatto cosa: accessi riusciti e falliti, inviti, modifiche ai permessi, deploy, riavvii, modifiche a variabili e impostazioni, terminali aperti, backup, ripristini, aggiornamenti, eliminazioni. Si filtra per categoria e periodo. Ogni account vede solo le voci sulle risorse che può vedere, e le voci di sicurezza solo chi gestisce gli utenti. Con più server ogni server tiene il proprio registro, e la pagina mostra quello del server selezionato.

Il proprietario sceglie quali categorie registrare (Sicurezza, Deploy, Configurazione, Terminale, Backup, Sistema, Eliminazioni; Sicurezza è sempre attiva) e per quanti giorni conservarle, da 1 a 3650 (90 di default). Le voci contengono nomi, mai valori segreti, e una scrittura del registro non riuscita non blocca l'azione che descrive.

## Aggiornare da una versione con la sola password

Se il pannello era stato configurato quando aveva una sola password, il primo accesso dopo l'aggiornamento si fa lasciando vuota l'email; subito dopo il pannello la chiede. Le sessioni aperte restano valide.
