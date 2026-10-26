[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/domains.md)

---

# Domini

Ogni progetto con una porta può essere servito su un sottodominio in HTTPS: `app.esempio.it` invece di `203.0.113.7:3001`. Il pannello scrive i server block per l'**nginx** che hai già sulla macchina e chiede a **certbot** un certificato Let's Encrypt per ogni nome; i blocchi scritti da te non vengono mai toccati.

## Cosa serve

- Linux, con nginx e certbot installati (per esempio `sudo apt install nginx certbot`).
- Un dominio tuo e, presso il suo provider DNS, **un solo record wildcard**: `*.esempio.it` → l'indirizzo pubblico del server (`A`, più `AAAA` se ha IPv6). Un record copre tutti i sottodomini e ogni nome ha il suo certificato.
- Le porte 80 e 443 che arrivano a nginx: sulla 80 Let's Encrypt verifica il nome, per il primo certificato e a ogni rinnovo. Per i domini su [Cloudflare](#domini-su-cloudflare) la verifica passa invece dal DNS.

## Preparare nginx

Una volta per server, da **Sistema › Domini** (serve il permesso *Accesso all'host*):

- **Pannello che gira da root**: premi **Configura**.
- **Altrimenti**: la pagina mostra i comandi da incollare in un terminale con sudo, poi premi **Ho eseguito i comandi**.

La preparazione aggiunge un solo file alla configurazione di nginx, `/etc/nginx/conf.d/runpanel.conf`, che include `/var/lib/runpanel-proxy/sites/*.conf`. Quella cartella, il webroot di certbot e i certificati stanno in `/var/lib/runpanel-proxy`, dell'utente del pannello, così certbot gira senza root. Testare e ricaricare nginx è l'unica cosa che richiede root, e il pannello ci arriva in uno di tre modi:

| Come gira il pannello | Come ricarica nginx |
|---|---|
| da root | esegue da sé `nginx -t` e `nginx -s reload` |
| sotto systemd (anche con la unit di RunPanel) | scrive un file di richiesta; due path unit di root lanciano `/usr/local/sbin/runpanel-nginx`, che testa, ricarica e lascia l'esito in `/run/runpanel-proxy` |
| senza systemd | una regola sudo che consente solo `nginx -t` e `nginx -s reload` |

La strada systemd non è un giro inutile: la unit di RunPanel imposta `NoNewPrivileges=yes`, con cui sudo non può funzionare — ed è un'impostazione da tenere, perché impedisce anche a ogni progetto nativo sotto il pannello di usare sudo.

Cancellare `/etc/nginx/conf.d/runpanel.conf` e ricaricare spegne in un colpo tutti i nomi gestiti.

## Dare un nome a un progetto

1. In **Sistema › Domini** aggiungi il dominio (`esempio.it`).
2. Nel progetto, **Impostazioni › Dominio**: scrivi il sottodominio, scegli il dominio, **Assegna**.

Il pannello scrive il blocco, ricarica nginx, controlla che il nome arrivi davvero a questo server e chiede il certificato in background: dopo qualche secondo il nome risulta *HTTPS attivo*. Se la richiesta non va, il motivo compare sotto il nome (il messaggio di Let's Encrypt, per esempio `NXDOMAIN` quando manca il record DNS) con **Richiedi il certificato** per riprovare.

I certificati li rinnova il pannello, che controlla due volte al giorno come fa certbot: il rinnovo avviene solo negli ultimi 30 giorni, e ogni nome mostra la sua scadenza. Let's Encrypt non manda più email di scadenza, quindi l'indirizzo in **Email per Let's Encrypt** è facoltativo: è solo il contatto dell'account.

## Domini su Cloudflare

Se il DNS di un dominio sta su Cloudflare, il pannello può chiedere i certificati tramite la sua API: funzionano anche con il record in proxy (nuvola arancione) e con la porta 80 chiusa.

1. Su Cloudflare, **My Profile › API Tokens › Create Token**, con i permessi **Zone · Zone · Read** e **Zone · DNS · Edit** sulle zone che vuoi usare.
2. In **Sistema › Domini › Cloudflare** incolla il token e premi **Collega**: il pannello lo prova elencando le zone, e lo rifiuta con il motivo di Cloudflare se non basta.
3. La pagina mostra i domini del tuo account: **Aggiungi** li porta fra i domini del pannello. Quelli già aggiunti la cui zona è attiva su Cloudflare prendono l'etichetta *Cloudflare*, e i nomi che aspettavano un certificato, o se l'erano visto rifiutare sulla porta 80, lo richiedono da soli.

Per un dominio su Cloudflare certbot fa la verifica DNS-01: un hook del pannello pubblica il record TXT `_acme-challenge` tramite l'API, aspetta che i nameserver di Cloudflare lo restituiscano e lo cancella a verifica finita. Il token è cifrato nello store del pannello e arriva a certbot solo nell'ambiente di ogni esecuzione: non finisce mai in un file né nelle impostazioni di rinnovo.

**Con la nuvola arancione.** In Cloudflare metti **SSL/TLS** su **Full (strict)**: con *Flexible* Cloudflare parla HTTP al server, che una volta in HTTPS lo rimanda su HTTPS, e la pagina gira in tondo. Dietro il proxy ogni connessione arriva da Cloudflare, quindi nei blocchi di questi domini nginx prende l'indirizzo del visitatore da `CF-Connecting-IP`, e solo dagli [indirizzi di Cloudflare](https://www.cloudflare.com/ips/): le regole d'accesso dei progetti continuano a valere, e chi aggira Cloudflare non può scegliersi l'indirizzo.

Se scolleghi Cloudflare, i certificati già emessi restano e al rinnovo i loro nomi tornano alla verifica sulla porta 80. Allo stesso modo, un dominio che entra o esce dall'account cambia verifica al primo rinnovo.

## Come un nome arriva all'app

nginx inoltra alla porta su cui l'app ascolta davvero, in loopback, passando `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` e i WebSocket, con un limite di 100 MB per richiesta. Se cambi la porta del progetto o le sue regole d'accesso il blocco si riscrive da solo; eliminando il progetto se ne vanno anche i suoi nomi e i loro certificati.

**Progetti limitati.** Un nome segue le [regole di rete](network.md) del progetto: nginx consente gli stessi indirizzi (e questa macchina) e rifiuta gli altri. Per esporre un progetto **solo** in HTTPS, limita la sua porta con la lista vuota ("solo questa macchina") e spunta **Raggiungibile da tutti tramite il nome**: la porta resta chiusa all'esterno, il nome è aperto.

## Cosa viene rifiutato

- Un nome già servito da un altro blocco di nginx: nginx ne terrebbe uno solo e vincerebbe quello gestito, quindi il pannello lo lascia fuori e lo scrive sotto il nome.
- L'indirizzo del pannello stesso (**Impostazioni › Pannello › Indirizzo pubblico**).
- Un nome assegnato due volte, un progetto senza porta, un dominio ancora in uso.

## Limiti

- Un solo livello di sottodominio (`app.esempio.it`, non `api.app.esempio.it`) e niente dominio principale.
- Per server: il record wildcard punta a una macchina, quindi con [più server](multi-server.md) ciascuno ha i suoi domini — per esempio `*.s1.esempio.it`.
- I nomi sconosciuti sotto la wildcard finiscono sul server di default di nginx. Se è il pannello, valuta un blocco catch-all che risponde `444`.
- L'include funziona dove `nginx.conf` carica `/etc/nginx/conf.d/*.conf` dentro `http {}`, come fanno Debian, Ubuntu e RHEL di serie. Con un `nginx.conf` scritto a mano che non lo fa, aggiungi tu quella riga.
- Con SELinux attivo (RHEL, Fedora) nginx può vedersi negare `/var/lib/runpanel-proxy` finché la cartella non ha l'etichetta giusta (`semanage fcontext` e `restorecon`).
- Non disponibile quando il pannello gira in un container, o con `RUNPANEL_DISABLE_SCHEDULERS`, che tiene un'istanza di prova lontana dall'nginx dell'host.
