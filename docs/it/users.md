# Utenti e permessi

[← Torna al README](../../README.it.md)

Il pannello può avere più account. Il primo è il **proprietario**: lo crea il setup iniziale, ha sempre tutti i permessi e nessuno può limitarlo, disattivarlo o eliminarlo. Ogni altro account nasce senza accessi e riceve solo quello che gli dai.

## Accedere

Si entra con email e password. Il pannello non invia email: l'email è solo il nome con cui accedi.

Se aggiorni un pannello configurato quando esisteva solo la password, il primo accesso dopo l'aggiornamento si fa lasciando vuota l'email. Subito dopo il pannello te la chiede, e da lì in poi vale email + password. Le sessioni aperte restano valide durante l'aggiornamento.

## Invitare qualcuno

In **Utenti → Invita utente** scrivi l'email e scegli per quanto vale il link: 1 ora, 24 ore, 7 giorni oppure una durata a piacere fino a 30 giorni. Il pannello mostra il link **una volta sola**. Lo mandi tu alla persona, nel modo che preferisci. Il link funziona una volta, poi la persona sceglie la password ed entra.

Dalla pagina di un account puoi generare un nuovo link: è un invito se l'account non ha ancora una password, altrimenti serve a sceglierne una nuova. Ogni link nuovo invalida quelli non usati. Una password dimenticata si risolve così, perché il pannello non manda mail di reset.

## Cosa può fare un account

### Progetti e servizi

Un accesso punta a **tutto**, a una **cartella**, a un **progetto** o a un **servizio**, con uno di tre livelli:

| Livello | Cosa permette |
|---|---|
| Lettura | stato, log, storico dei deploy, nomi delle variabili con valori mascherati |
| Operatore | in più deploy, avvio, stop, riavvio |
| Gestione | in più impostazioni, variabili in chiaro, file, mount, comandi una tantum, eliminazione |

L'interruttore **Terminale e console**, attivabile da Operatore in su, apre una shell nei container. Ogni persona ha la sua sessione: nessuno vede l'output di un altro.

Vale il livello più alto tra gli accessi che riguardano un elemento. Un accesso a una cartella vale anche per ciò che ci finisce dopo. Un servizio collegato a un progetto segue l'accesso del progetto. Per togliere un accesso si toglie la riga: non esistono regole di divieto.

Chi non vede un progetto riceve "non trovato", come se non esistesse.

### Permessi del pannello

Sono interruttori per account: Crea progetti e servizi, GitHub, Registry, Storage, Backup, Ripristino, Monitor, Avvio automatico, Diagnostica, Notifiche, Aggiornamenti, Accesso all'host, Gestione utenti, Registro attività. Le voci del menu e i pulsanti seguono questi permessi, ma il controllo vero lo fa il server su ogni richiesta e su ogni stream.

Tre permessi vanno dati con attenzione:

- **Accesso all'host.** Runtime nativi (PM2), Compose, mount di cartelle, cap Docker, rete host, comandi una tantum e modifica del codice di un progetto (file, upload, repository) possono uscire dal container. Arrivano fino al database del pannello e alla sua chiave segreta. Senza questo permesso, anche chi ha Gestione su un progetto lavora solo su container Docker semplici.
- **Backup e Ripristino.** Senza essere proprietario si salvano e si ripristinano solo i progetti e i servizi che si gestiscono, uno per uno. Il backup del pannello e quello con la chiave segreta restano al proprietario.
- **Gestione utenti.** Chi lo ha non può toccare il proprietario né sé stesso. Non può concedere un permesso o un livello che non possiede, né modificare o reimpostare un account che ha più accessi dei suoi.

I **modelli rapidi** (Visualizzatore, Sviluppatore, Operatore sistema) compilano i campi in un clic. Dopo li puoi ritoccare liberamente.

### Chi ha accesso

Nelle impostazioni di un progetto o di un servizio, chi gestisce gli utenti vede l'elenco degli account che lo raggiungono, con il livello e la provenienza dell'accesso, e da lì può cambiarli.

## Revoca

Togliere un accesso, disattivare un account o chiudere una sessione ha effetto subito. Gli stream aperti si chiudono, e lo stesso vale per le shell di quell'utente. Disattivare un account lo disconnette da ogni dispositivo.

## Registro attività

**Registro attività** elenca chi ha fatto cosa: accessi riusciti e falliti, inviti, modifiche ai permessi, deploy, riavvii, modifiche a variabili e impostazioni, terminali aperti, backup, ripristini, aggiornamenti, eliminazioni. Si filtra per categoria e periodo. Ogni account vede solo le voci sulle risorse che può vedere, e le voci di sicurezza solo chi gestisce gli utenti.

Il proprietario sceglie quali categorie registrare e per quanti giorni conservarle (90 di default). La categoria Sicurezza è sempre attiva. Le voci contengono nomi, mai valori segreti, e una scrittura del registro non riuscita non blocca l'azione che descrive.
