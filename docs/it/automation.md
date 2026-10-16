[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/automation.md)

---

# Automazione dei deploy

Si configura nella scheda **Impostazioni** del progetto, sezione **Deploy automatico**. Il campo *Come parte il deploy* sceglie tra due modi:

- **Webhook**: GitHub avvisa a ogni push e il deploy parte subito. Serve un server raggiungibile da internet.
- **Controllo periodico**: RunPanel interroga GitHub a intervalli e distribuisce quando il commit cambia. Solo richieste in uscita: funziona anche dietro NAT, VPN o Tailscale.

Sceglierne uno disattiva l'altro, perché due trasporti attivi distribuirebbero lo stesso commit due volte. Entrambi seguono il branch del progetto; un progetto fermo su un commit li ignora (vedi [Tornare a un commit](#tornare-a-un-commit)).

## Webhook

Ogni progetto ha un URL webhook e un segreto propri. Le firme sono verificate con HMAC-SHA256; ogni consegna, accettata o rifiutata, finisce nello storico con il motivo.

Con il **token GitHub** collegato, accendere il deploy automatico **registra il webhook da solo** sul repository (evento `push`, `application/json`). Spegnerlo lo disattiva senza cancellarlo. Un webhook creato a mano con lo stesso URL viene riconosciuto e corretto, non duplicato. Per gestire i webhook il token deve avere lo scope `repo` o `write:repo_hook` (token classico) o il permesso *Webhooks: Read and write* (token fine-grained); un repository di un'organizzazione può richiedere di autorizzarlo. Senza token, URL e segreto sono lì da copiare per configurarlo a mano.

La sezione dice cosa non va: token assente, repository non riconosciuto, indirizzo che GitHub non raggiunge, webhook disallineato, ultima consegna rifiutata. Mostra le ultime 10 consegne ricevute e le ultime 10 viste da GitHub; lo storico dura 30 giorni. **Invia ping** chiede a GitHub una consegna vera, che passa da DNS, firewall, TLS e firma. Se il progetto è rimasto bloccato in "deploy in corso", ogni push risponde "in coda" e non succede niente: il pulsante **Sblocca** lo libera.

L'indirizzo che il pannello scrive su GitHub è **Indirizzo pubblico** in **Impostazioni › Pannello** (solo il proprietario). Lasciato vuoto viene dedotto dalla richiesta, che va bene solo se apri il pannello dallo stesso indirizzo con cui GitHub lo raggiunge. Con [più server](multi-server.md) il webhook arriva al server che ospita il progetto: imposta l'indirizzo pubblico su ogni server, con quel server selezionato, e ricorda che anche un server con ruolo nodo deve essere raggiungibile da internet per ricevere webhook.

> **Raggiungibile solo via VPN o Tailscale?** I webhook non arrivano: GitHub consegna da internet. Un indirizzo `100.64–100.127.x.x` viene rifiutato subito; un nome MagicDNS `*.ts.net` viene segnalato, perché funziona solo pubblicato con `tailscale funnel`. Usa il controllo periodico.

## Controllo periodico

Richiede il token GitHub collegato e un repository su `github.com`: senza token il controllo non parte e la sezione lo segnala in rosso.

L'intervallo si imposta in **Impostazioni › Pannello** (solo il proprietario), da 30 secondi a 30 minuti, predefinito 5 minuti. Un branch fermo costa una risposta `304 Not Modified`, che GitHub non conta nel limite orario. Il ritardo massimo di un deploy è un intervallo più una quindicina di secondi. Con più server ogni server controlla i propri progetti con il proprio intervallo, e tutti usano lo stesso token condiviso.

Il primo giro dopo l'attivazione **registra** il commit attuale senza distribuirlo: si distribuisce quello che arriva dopo. Ogni commit nuovo ha un solo tentativo: se il deploy fallisce, non viene ritentato finché non arriva un altro commit. I deploy così avviati compaiono nello storico con trigger `poll`. Se l'ultimo controllo è più vecchio di tre intervalli, la sezione diventa gialla.

## Tornare a un commit

Il pulsante accanto a **Deploy** apre la cronologia del repository: scegli branch e commit, poi **Distribuisci**. Serve quando l'ultimo commit ha rotto l'app.

La scelta **resta**: ogni deploy ricostruisce quel commit, l'intestazione lo segnala e il deploy automatico è sospeso. Le consegne che arrivano nel frattempo restano nello storico come ignorate. **Torna all'ultimo commit**, nel menu **Altro**, scioglie il blocco e distribuisce la testa del branch. Anche cambiare il branch nelle impostazioni scioglie il blocco.

Scegliere un altro branch nella cronologia cambia il branch del progetto, che da lì in avanti segue quello. L'elenco dei commit viene dall'API di GitHub e richiede il token; senza, o per un commit più vecchio degli ultimi cento, si incolla lo SHA completo di 40 caratteri.

**Le migrazioni del database non tornano indietro.** Una versione che si aspetta uno schema più vecchio può non partire; il pannello lo ricorda prima di procedere.

## Comandi una tantum

I comandi del contratto girano a ogni deploy. Quelli una tantum girano una volta, al passo che scegli, poi escono dalla coda: una migrazione da fare adesso, un `git submodule update`, un fix di permessi. Si scrivono in **Impostazioni › Comandi una tantum** e richiedono il permesso **Accesso all'host**. Finché la coda non è vuota, accanto al nome del progetto compare il numero di comandi in attesa.

| Passo | Quando | Docker | Compose | Nativo |
|---|---|---|---|---|
| Prima del deploy | Prima di toccare qualsiasi cosa; l'app vecchia gira | host | host | host |
| Dopo il git | Commit nuovo sul disco, variabili caricate | host | host | host |
| Prima dell'install | Subito prima delle dipendenze | — | — | host |
| Dopo l'install | Dipendenze installate, build non ancora fatto | — | — | host |
| Dopo il build | Build riuscito, prima del release command | container | host | host |
| Prima dell'avvio | Processo vecchio fermo, nuovo non ancora partito | container | host | host |
| Dopo l'avvio | Processo avviato, health check non ancora passato | container | host | host |
| A deploy riuscito | Health check passato | container | host | host |

Con Docker e Compose install e build sono un unico passo, quindi i due passi attorno all'install non esistono; su un progetto statico girano uno dopo l'altro subito prima del build. Sotto Docker i passi dopo il build usano un container usa-e-getta dall'immagine appena costruita, con la stessa rete, gli stessi mount e lo stesso ambiente del release command. Con Compose girano sempre sull'host: per entrare in un servizio scrivi `docker compose run --rm api sh -c '…'`. Se cambi runtime e un comando in coda non ha più un passo valido, resta in coda segnalato e il log del deploy dice perché non è partito.

**Se un comando fallisce, il deploy fallisce** e il comando resta in coda per il deploy successivo, con tentativi ed errore visibili. Con *Continua anche se fallisce* il deploy prosegue e il comando viene consumato, registrato come fallito. Un comando riuscito va nella cronologia (passo, durata, commit), che si svuota a mano o da sola dopo 90 giorni. Un fallimento in *A deploy riuscito* segna il deploy come fallito anche se l'app è viva e sana.

Limiti: 10 minuti per comando, 50 comandi in coda, 4000 caratteri per comando. La coda viene presa all'inizio del deploy: un comando aggiunto durante un deploy vale per il successivo, e mentre il deploy la tiene non si può modificarla.

Stanno fuori dal [contratto di deploy](deploy.md#il-contratto-di-deploy) perché il contratto si fonde con il `runpanel.json` del repository: lì sarebbero comandi sull'host scelti da chiunque possa fare push. Non metterci password: il comando finisce nel log.

L'esecuzione è **almeno una volta**: se il pannello si riavvia mentre un comando gira, il comando torna in coda e ripartirà, e la riga interrotta viene segnalata.
