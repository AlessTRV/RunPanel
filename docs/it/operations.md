[← RunPanel](../../README.md) · **Italiano** · [English](../en/operations.md)

---

# Operatività

## Avvio automatico

La pagina Autostart riferisce cosa questa macchina fa già e genera quello che non
fa: una unit systemd con percorsi assoluti, ordinata dopo `docker.service` e che
lo richiede, oppure uno script `@reboot` supervisionato quando systemd non c'è.
Se RunPanel gira da root la installa; altrimenti produce un unico blocco da
incollare. Non esegue mai `systemctl start`: metterebbe un secondo pannello sulla
porta accanto a quello in esecuzione.

Controlla anche le cose che rendono inutile l'avvio automatico quando mancano: se
Docker stesso è abilitato all'avvio, e se `pm2 save` è mai stato eseguito — senza,
PM2 non rimette su niente dopo un riavvio, anche quando il pannello torna.

Dentro il pannello, ogni progetto e ogni servizio ha un interruttore, un ordine,
un ritardo, e se aspettare che risponda prima di avviare il successivo. Il
riconciliatore che applica tutto questo all'avvio è una passata di **riparazione**:
aspetta che i riavvii automatici di Docker si assestino e avvia solo ciò che è
ancora giù, e non innesca mai un build.

La unit generata contiene `KillMode=process`: senza, un `systemctl stop runpanel`
fermerebbe anche PM2 e tutti i progetti con runtime nativo che supervisiona. I
container Docker non sono mai coinvolti. Se la unit è stata installata prima, la
pagina Autostart lo dice e basta reinstallarla.

Lo stato mostrato negli elenchi viene riverificato da solo, ogni mezzo minuto e
al termine della riconciliazione d'avvio: un progetto può quindi passare a
**Fermo** senza che nessuno l'abbia spento in quel momento, e significa che non
era più su da prima. Il controllo non avvia e non ferma niente, e per dichiarare
fermo qualcosa che risultava avviato aspetta due letture d'accordo, così un
`pm2` che non risponde per un istante non tinge di rosso l'intero pannello.

## Aggiornare il pannello

RunPanel si installa clonandolo, quindi la cartella da cui gira è un working tree
git: è tutto quello che serve perché sappia se c'è una versione più recente. La
versione mostrata è `v0.1.0+125`, dove il numero dopo il `+` è il conteggio dei
commit sul ramo principale (`git rev-list --count --first-parent`); su un
checkout shallow il conteggio non ha senso e il pannello mostra lo SHA. Ogni sei
ore — l'intervallo si cambia dalla pagina — fa un `git fetch` sul proprio remote
e confronta: solo traffico in uscita, e per un repository pubblico non serve
alcun token. Quando il branch si è mosso compare una striscia in cima a ogni
pagina con il numero di commit e un pulsante **Aggiorna**; la pagina
Aggiornamenti mostra l'elenco dei commit.

Il controllo **non applica mai niente da solo**.

Premuto il pulsante, il pannello copia lo store, scarica, allinea il checkout,
installa le dipendenze, builda e si riavvia. Due cose da sapere:

- **La build non va in `.next`.** La nuova versione si costruisce in
  `.next-update` e prende il posto di quella in uso con due rename, solo dopo
  essere stata verificata; la precedente resta in `.next-old` fino al riavvio
  successivo.
- **Il riavvio è un'uscita.** Il pannello esce con codice 75 e a rimetterlo su ci
  pensa chi lo supervisiona già: systemd con `Restart=always`, o il ciclo dello
  script `@reboot`. Non serve `systemctl` né alcun privilegio.

Se qualcosa fallisce prima dello scambio, il checkout torna al commit di partenza
e le dipendenze vengono reinstallate: `.next` non è mai stato toccato, quindi il
pannello continua a girare sulla versione di prima senza accorgersi di niente.

L'aggiornamento viene rifiutato quando il pannello non è un checkout git, quando
HEAD è staccato, quando gira in un container — lì la strada è ricostruire
l'immagine — e su Windows, dove la cartella di build non si può rinominare mentre
il processo la tiene aperta. Se non c'è nessun supervisore l'aggiornamento viene
comunque scaricato e costruito, ma si ferma **prima** dello scambio e ti consegna
i due comandi da eseguire.

Le modifiche locali non committate vengono scartate (`git reset --hard` seguito
da `git clean -fd`). Il `clean` è senza `-x`, quindi non tocca niente di ignorato
— `data/`, `node_modules/`, `.next` — e i file `.env*` sono esclusi
esplicitamente. Quello che sta per essere rimosso viene elencato nel log prima di
rimuoverlo.

Prima di iniziare, il pannello prende una copia del proprio store con
`VACUUM INTO` e ne scrive il percorso nel log. Un aggiornamento viene rifiutato
mentre c'è un deploy o un backup in corso.

Se il pannello non dovesse tornare su, i comandi per rimettere la versione
precedente sono in due posti che non richiedono un pannello funzionante: stampati
nel journal appena prima dell'uscita, e in `<dataDir>/panel-update.json`.

## Notifiche su Telegram

Il pannello sa avvisarti quando succede qualcosa che vorresti sapere senza avere
il pannello aperto. Si configura da **Impostazioni → Notifiche Telegram**: crei
un bot con `@BotFather`, incolli il token, scrivi un messaggio qualsiasi al bot e
premi **Rileva** — il pannello chiede a Telegram chi gli ha scritto e ti fa
scegliere la chat, così non devi andare a cercarti l'id da un'altra parte.

Telegram è scelto per la stessa ragione per cui esiste il
[controllo periodico dei repository](automation.md): **il pannello parla solo in
uscita**, e non serve che sia raggiungibile da internet. Il rovescio della
medaglia è che al bot non si può parlare: non ci sono comandi, manda e basta.

Il token è cifrato a riposo come quello di GitHub e non viene mai restituito da
questa pagina: lo schermo sa solo se ce n'è uno.

### Cosa viene notificato

| Evento | Quando |
|---|---|
| **Progetto o servizio fermo** | Il processo non c'è più e non è stato il pannello a fermarlo |
| **Docker non risponde** | Il daemon è irraggiungibile, e di nuovo quando torna |
| **Deploy concluso** | Sempre per i deploy automatici; per quelli manuali solo se falliscono |
| **Backup concluso** | Riuscito, parziale o fallito, con artefatti, dimensione e durata |
| **Aggiornamento disponibile** | Il controllo periodico ha trovato commit nuovi su RunPanel |
| **Il pannello è ripartito** | Dopo un riavvio o un aggiornamento |
| **Spazio su disco** | Sotto il 10% libero sulla cartella dei dati, e quando rientra |

Ogni voce ha il suo interruttore: una che fa troppo rumore si spegne senza
perdere le altre.

I crash sono confermati su due letture, quindi un `pm2` che non risponde per un
istante non manda niente.

Il deploy manuale non viene annunciato quando riesce — lo stai già guardando, con
il log che scorre — ma se fallisce sì.

### Perché non ti sommerge

Tutto è **edge-triggered**: viene notificato il momento in cui una soglia viene
attraversata, non lo stato. La soglia del disco ha due punti di isteresi. Sopra a
questo c'è un silenzio di quindici minuti per evento e per soggetto — per
soggetto, non globale, così un progetto che sbatte non copre un altro che cade
nello stesso momento. L'aggiornamento del pannello è annunciato quando cambia il
commit di destinazione, non finché ne esiste uno.

### Se la notifica non parte

Non succede niente: un deploy non fallisce perché Telegram non risponde. Un
invio non riuscito finisce nel log del pannello con il motivo, tradotto dove
Telegram è particolarmente criptico — `chat not found` di solito vuol dire che al
bot non hai ancora scritto, e finché non gli scrivi tu un bot non può scriverti.
