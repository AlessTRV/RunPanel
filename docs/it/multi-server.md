[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/multi-server.md)

---

# Più server

Un RunPanel può gestire altri RunPanel. Ogni installazione resta completa e autonoma: progetti, database, backup e aggiornamenti girano lì, con il suo Docker e la sua cartella `data/`. Si condivide il pannello: gli account sono gli stessi ovunque, e da qualunque pannello si vedono e si comandano tutti i server collegati.

L'insieme dei server collegati è un **cluster**. Non serve niente di raggiungibile da internet: i server si parlano su una rete privata con richieste firmate. La rete deve essere cifrata (Tailscale o WireGuard lo sono già) oppure i server vanno messi dietro HTTPS: al collegamento e alla rotazione viaggia il segreto del cluster, e con gli account viaggiano il token GitHub e quello del bot Telegram.

## Collegare un server

1. Sul pannello esistente: **Sistema › Server › Collega un server**. Il pannello genera un token valido un'ora e una volta sola, e mostra il proprio indirizzo (preso da **Impostazioni › Pannello › Indirizzo pubblico**, o dalla richiesta). Il primo token crea anche il cluster.
2. Sul server nuovo: installa RunPanel come sempre e apri la sua porta. Nella pagina di primo avvio scegli **Collega a un RunPanel** invece di creare il proprietario, e inserisci il token di setup (stampato nel log, come sempre), l'indirizzo del pannello, il token di collegamento, un nome e l'indirizzo con cui il pannello raggiunge questo server.
3. Scegli il ruolo: **Pannello** se anche questo server deve mostrare l'interfaccia, **Solo nodo** se deve solo essere gestito.

Il server nuovo contatta il pannello, riceve il segreto del cluster e gli account, e da quel momento il pannello lo chiama. Compare subito in **Sistema › Server** con stato, versione e ultimo contatto.

L'indirizzo del server nuovo è quello con cui lo raggiunge il **pannello**, non quello del tuo browser: con un tunnel SSH o `localhost` il collegamento riesce ma il server risulta irraggiungibile (il form lo segnala).

Si collega solo un'installazione al primo avvio, con una `data/` vuota. I progetti di un server non si spostano da un server all'altro.

## Ruoli

- **Pannello**: mostra l'interfaccia, accetta gli account del cluster e gestisce tutti i server, compreso collegarne e revocarne altri.
- **Nodo**: nessun accesso diretto. Chi apre la sua porta vede "Questo server è gestito da …" con i link ai pannelli.

Il ruolo si cambia da **Sistema › Server** e vale per tutti. Un pannello che diventa nodo chiude le sessioni aperte.

## Tutti i server nel pannello

Il server di una pagina sta nel suo indirizzo (`?server=…`): un link a un progetto di or apre sempre or, chiunque lo apra. Il selettore in alto a destra (nel menu, su telefono) cambia quel parametro.

- **Liste di tutti i server.** **Panoramica**, **Progetti**, **Servizi**, **Backup**, **Monitor**, **Diagnostica** e **Aggiornamenti** mostrano tutti i server insieme, ogni riga con il nome del suo server; il filtro "Tutti i server" li restringe a uno. Un server che non risponde compare come "non raggiungibile" e non blocca la lista.
- **Panoramica.** Una scheda per server con CPU, memoria, disco, Docker, versione, progetti attivi e avvisi (disco quasi pieno, versione diversa, cose da sistemare, aggiornamento disponibile). Sotto, progetti e servizi divisi per server, ognuno con le sue cartelle. Le stesse schede sono in **Sistema › Server**.
- **Azioni.** Avviare un servizio, eseguire un backup, scaricare un archivio, applicare una correzione della diagnostica o aggiornare un server partono sempre dal server della riga.
- **Creare.** Nuovo progetto, nuovo database, nuova cartella e nuova pianificazione di backup chiedono su quale server.
- **Pagine di un server.** La pagina di un progetto o di un servizio, Avvio automatico, Pulizia Docker, Impostazioni e Registro attività riguardano un server alla volta: il nome del server compare nel percorso in alto. Un link a un progetto che sta su un altro server porta lì da solo.
- **Palette dei comandi** (Ctrl+K) cerca progetti e servizi su tutti i server, **Notifiche Telegram** iniziano con il nome del server che le manda, e il banner degli aggiornamenti dice su quale server ce n'è uno.

I permessi sono quelli dell'account anche sull'altro server: chi può leggere un progetto lo legge ovunque esso stia.

Restano del pannello che stai usando, qualunque server sia selezionato: **Accessi › Utenti**, il tuo account e le sessioni, il colore d'accento e la frequenza di aggiornamento delle pagine.

## Cosa si condivide

Utenti, permessi e accessi sono replicati su tutti i server e si modificano da qualunque pannello. Ogni modifica viene spinta subito agli altri, nodi compresi, e un controllo al minuto ripara quello che non è arrivato (un server spento, per esempio). Se due server modificano lo stesso account, vince la modifica più recente. Un account cancellato lascia una traccia per 30 giorni, perché una copia vecchia non lo faccia tornare.

Si condividono anche il token GitHub e il bot Telegram (token e chat): ogni server clona e notifica con le stesse credenziali, e le cifra con la propria chiave.

Restano di ogni server: le sessioni (si entra su ogni pannello separatamente), i link di invito (si aprono sul pannello che li ha generati), il registro attività, backup e destinazioni, registry, indirizzo pubblico, intervallo del controllo periodico, impostazioni di aggiornamento e quali notifiche inviare.

## Diagnostica

**Diagnostica**, accanto a ogni server in **Sistema › Server**, lo interroga e confronta: raggiungibile, stesso segreto (la firma viene accettata), stesso cluster, versione, orologio e account allineati. Una versione diversa è evidenziata anche nell'elenco. L'orologio diventa rosso oltre i due minuti e mezzo di differenza; oltre i cinque le richieste vengono rifiutate, perché la firma scade.

Un nodo non ha un pannello suo: i suoi aggiornamenti si gestiscono da **Sistema › Aggiornamenti** del pannello, che elenca tutti i server. Per ognuno ci sono la versione, i commit in arrivo, **Controlla**, **Aggiorna** e la frequenza del controllo automatico (ogni 1, 6 o 24 ore), che il server esegue da sé e notifica su Telegram con il suo nome. **Controlla tutti** e **Aggiorna tutti** agiscono su ogni server insieme, con il pannello per ultimo. **Dettagli** apre commit e log in diretta di quel server. Un server che si aggiorna si riavvia da solo e per qualche secondo risulta irraggiungibile; il controllo non applica mai niente da solo.

## Revoca e segreto

**Revoca** scollega un server: viene avvisato (se risponde), rimosso ovunque e torna indipendente, con la copia degli account che aveva e i suoi progetti. Un pannello revocato tiene le sue sessioni; un nodo no.

Il server revocato conosce ancora il segreto, quindi la revoca propone di **rigenerare il segreto** (c'è anche un pulsante a parte, **Rigenera il segreto**). I server rimasti ricevono quello nuovo in una richiesta firmata con il vecchio, con un secondo tentativo per chi non risponde. Il vecchio resta valido dieci minuti: in quel tempo, a un server rimasto fuori si può dare il segreto con **Reinvia il segreto** (accanto al server, o nella sua diagnostica quando la firma viene rifiutata). Passati i dieci minuti non c'è più un segreto in comune: va revocato e reinstallato con una `data/` vuota.

## Sicurezza

- Ogni chiamata tra server porta una firma HMAC-SHA256 su metodo, percorso, corpo, utente e orario, con il segreto del cluster. Vale cinque minuti e **una volta sola**: una richiesta catturata non si può rigiocare né puntare su un'altra route.
- Il segreto è cifrato a riposo su ogni server e non compare nei log. Viaggia solo al collegamento e alla rotazione: per questo la rete tra i server va cifrata.
- Un nodo non risponde senza firma: la sua porta mostra solo la pagina "gestito da".
- L'ingresso nel cluster è limitato a 10 tentativi ogni 15 minuti, e il token vale una volta.

## Limiti

- Lo stato "invitato" di un utente non è replicato: su un altro pannello compare come "invito scaduto" finché non imposta la password.
- Una cartella appartiene al server su cui è stata creata.
