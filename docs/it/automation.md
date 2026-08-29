[← RunPanel](../../README.md) · **Italiano** · [English](../en/automation.md)

---

# Automazione dei deploy

## Deploy automatico

Ogni progetto ha un URL webhook con un segreto proprio. Attivando **Deploy
automatico**, un push sul branch configurato avvia un deploy. Le firme sono
verificate con HMAC-SHA256 e confronto a tempo costante; le consegne, accettate o
rifiutate, restano nello storico con il motivo.

Con un account GitHub collegato il webhook **si registra da solo**: attivare
l'interruttore lo crea sul repository con l'URL, il segreto, il content type
`application/json` e il solo evento `push` già impostati. Spegnere l'auto-deploy
lo disattiva senza cancellarlo, così lo storico delle consegne su GitHub resta.

La sezione mostra anche cosa non va: token assente, repository non riconosciuto,
indirizzo del pannello che GitHub non può raggiungere, webhook disallineato,
ultima consegna rifiutata. Il pulsante **Invia ping** chiede a GitHub una
consegna vera, che passa da DNS, firewall, TLS e firma.

Perché il pannello sappia quale indirizzo scrivere su GitHub, imposta
**Indirizzo pubblico** in Account → Preferenze. Lasciato vuoto viene dedotto
dalla richiesta, il che vale finché apri il pannello dallo stesso indirizzo da
cui lo raggiunge GitHub.

> **Pannello raggiungibile solo via VPN o Tailscale?** Allora i webhook non
> arrivano: GitHub consegna da internet e non fa parte della tua rete privata.
> Un indirizzo `100.64–100.127.x.x` viene rifiutato subito; un nome MagicDNS
> `*.ts.net` viene segnalato, perché funziona **solo** se lo pubblichi con
> `tailscale funnel`. Non serve esporre niente: usa il **controllo periodico**
> qui sotto.

## Controllo periodico, quando il pannello non è raggiungibile

Un webhook ha bisogno che GitHub apra una connessione **verso** questa macchina,
e dietro NAT, su Tailscale o WireGuard, su un portatile, non può: la consegna
fallisce prima di arrivare e nei log non resta nulla, perché il problema è la
direzione della connessione.

Quindi il pannello può anche **chiedere** invece di farsi avvisare. Nelle
impostazioni del progetto, *Deploy automatico → Come parte il deploy*:

- **Webhook** — GitHub avvisa a ogni push, il deploy parte subito. Richiede un
  pannello raggiungibile da internet.
- **Controllo periodico** — RunPanel guarda il branch a intervalli e distribuisce
  quando il commit cambia. Una richiesta in uscita, nessuna in entrata: funziona
  ovunque ci sia una connessione a internet.

L'intervallo è in Account → Preferenze, da 30 secondi a 30 minuti (predefinito 5
minuti). Un branch fermo risponde `304 Not Modified` grazie all'ETag, e GitHub
non conta le 304 nel limite orario di richieste: anche 30 secondi costano
praticamente nulla. Il ritardo massimo di un deploy è un intervallo.

Il primo giro dopo l'attivazione **registra** il commit corrente senza
distribuirlo — «distribuisci quello che arriva», non «distribuisci quello che
c'è adesso» — e i deploy così avviati compaiono nello storico con trigger
`poll`. Scegliendo il controllo periodico il webhook eventuale viene
disattivato, perché due trasporti attivi distribuirebbero lo stesso commit due
volte.

Il webhook resta configurabile a mano — URL e Secret sono lì da copiare — per i
repository che il token non amministra o per un pannello senza account collegato.

## Tornare a un commit preciso

Il pulsante accanto a **Deploy** apre la cronologia del repository: si sceglie il
branch, si sceglie il commit, e il progetto viene ricostruito da lì. Serve quando
il commit appena distribuito è quello che ha rotto l'app.

La scelta **resta**. Il progetto si ferma su quel commit: ogni deploy ricostruisce
quello, l'header lo dice con un'etichetta, e l'**auto-deploy viene sospeso** invece
di riportare il progetto in avanti al primo push. Le consegne che arrivano nel
frattempo restano nello storico come ignorate, con il motivo. **Torna all'ultimo
commit** scioglie il blocco e distribuisce di nuovo la testa del branch.

Scegliere un branch diverso qui cambia il branch del progetto: da lì in avanti è
quello che webhook e controllo periodico seguono. L'elenco dei commit arriva
dall'API di GitHub, quindi vuole un account collegato; senza, o per un commit più
vecchio degli ultimi cento, c'è un campo dove incollare lo SHA.

Il pannello lo ripete prima di procedere: **le migrazioni del database non
tornano indietro**. Se la versione ripristinata si aspetta uno schema più vecchio
di quello che c'è, può non partire.

## Comandi una tantum

I comandi del contratto girano a *ogni* deploy. Quelli una tantum girano una volta
sola, al punto della scala che scegli tu, e poi spariscono dalla coda: la
migrazione da fare adesso, un `git submodule update` dopo aver cambiato repository,
un fix di permessi, uno svuotamento di cache. Si scrivono in **Impostazioni →
Comandi una tantum**, e finché la coda non è vuota il pannello lo dice accanto al
pulsante Deploy.

| Passo | Quando | Docker | Nativo e Compose |
|---|---|---|---|
| Prima del deploy | Prima che venga toccato qualsiasi cosa; l'app vecchia gira ancora | host | host |
| Dopo il git | Nuovo commit sul disco, variabili caricate, niente ancora installato | host | host |
| Prima dell'install | Subito prima delle dipendenze | — | host |
| Dopo l'install | Dipendenze installate, build non ancora fatto | — | host |
| Dopo il build | Build riuscito, prima del release command | container | host |
| Prima dell'avvio | Processo vecchio fermo, nuovo non ancora partito | container | host |
| Dopo l'avvio | Processo avviato, health check non ancora passato | container | host |
| A deploy riuscito | Health check passato | container | host |

I due passi attorno all'install non esistono con Docker e Compose: lì install e
build sono un unico `docker build`. Se cambi il runtime di un progetto che ne
aveva uno in coda, il comando non sparisce: resta lì segnalato, e il log del
deploy dice perché non è partito.

Dove girano è deciso dal passo, non da un'opzione: sotto Docker i passi dopo il
build usano un container usa-e-getta creato dall'immagine appena costruita —
stessa rete, stessi mount, stesso ambiente, come il release command — mentre i due
prima del build girano sull'host. Con Compose girano sempre sull'host, e per
entrare in un servizio serve scriverlo a mano
(`docker compose run --rm api sh -c '…'`).

**Se uno fallisce, il deploy fallisce** e il comando **resta in coda**: sistemi la
causa e il deploy successivo lo riprova, con il numero di tentativi e l'errore
dell'ultimo sotto gli occhi. Se spunti *Continua anche se fallisce* il deploy tira
dritto e il comando viene consumato lo stesso, registrato come fallito. Quello che
riesce esce dalla coda e finisce nella cronologia, con passo, durata e commit; si
svuota a mano, e da sola dopo 90 giorni.

Un avvertimento su *A deploy riuscito*: se un comando lì fallisce, il deploy viene
registrato come fallito **anche se l'app è viva e sana**: è l'unico passo in cui
"fallito" non vuol dire "non sta servendo".

**Non stanno nel contratto di deploy, e non è una svista.** Il contratto si fonde
con il `runpanel.json` del repository, quindi un campo lì dentro sarebbe shell
arbitraria sull'host che chiunque possa pushare riesce a far girare. Stanno in una
tabella loro, dove niente si fonde e l'unico che scrive è una rotta autenticata:
un repository non li può toccare. Non metterci password: il comando finisce nel log del deploy.

L'esecuzione è **almeno una volta**, non esattamente una volta: se il pannello si
riavvia mentre un comando sta girando, il comando torna in coda e ripartirà, e la
riga interrotta viene segnalata.
