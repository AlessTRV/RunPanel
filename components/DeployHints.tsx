import Link from "next/link";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";

/**
 * The explanations that have to say the same thing in more than one place.
 *
 * The port field exists twice — in the creation wizard and in the project's
 * settings — and it means something different under each runtime. Written
 * inline it would be written twice, drift once, and then teach the wrong thing
 * on whichever screen was updated last.
 *
 * Everything here describes behaviour that is actually implemented: the port
 * mapping in `services/process-drivers/docker-driver.ts`, the `-p` rewrite in
 * `pm2-driver.ts`, the probe in `deploy-steps.ts`, the path resolution in
 * `env-file.ts` and the service linking in `deploy-pipeline.ts`. Change one of
 * those and the text here is part of the change.
 */

/** What the port field does, which is not the same thing on every runtime. */
export function PortHint({ runtimeType }: { runtimeType: string }) {
  if (runtimeType === "docker") {
    return (
      <FieldHint>
        Pubblicata come <Code>porta:porta</Code>, identica su host e container: l&apos;app dentro
        l&apos;immagine deve ascoltare esattamente lì. Arriva anche come <Code>PORT</Code>. Vuota:
        nessuna porta pubblicata e nessuna sonda HTTP, al deploy basta che il container sia acceso.
      </FieldHint>
    );
  }

  if (runtimeType === "compose") {
    return (
      <FieldHint>
        Le porte le dichiara il compose file. Qui serve solo a dire a RunPanel dove sondare
        l&apos;health check, su <Code>127.0.0.1</Code> dell&apos;host. Vuota: basta che lo stack sia
        su.
      </FieldHint>
    );
  }

  return (
    <FieldHint>
      Arriva al processo come <Code>PORT</Code>. Se lo start è <Code>next</Code>, <Code>vite</Code>{" "}
      o <Code>nuxt</Code> viene aggiunto anche <Code>-p porta</Code>, perché quei CLI ignorano{" "}
      <Code>PORT</Code>. Vuota: 3000.
    </FieldHint>
  );
}

/** Where the generated .env actually lands. The default path is a trap on PM2. */
export function EnvFilePathHint({ runtimeType }: { runtimeType: string }) {
  if (runtimeType === "docker") {
    return (
      <FieldHint>
        Percorso <strong>dentro il container</strong>: il file viene montato lì in sola lettura.{" "}
        <Code>/app/.env</Code> è quello giusto per quasi tutte le immagini Node.
      </FieldHint>
    );
  }

  return (
    <FieldHint>
      Percorso <strong>relativo alla root del progetto</strong>: lo slash iniziale viene ignorato,
      quindi <Code>/app/.env</Code> scrive in <Code>app/.env</Code> dentro il repository. Se
      l&apos;app legge un dotenv normale, il valore giusto è <Code>.env</Code>.
    </FieldHint>
  );
}

/** How the probe works, so the three numbers next to it mean something. */
export function HealthcheckHint() {
  return (
    <Hint>
      RunPanel chiama <Code>http://127.0.0.1:porta</Code> + path finché non risponde. Il path deve
      iniziare con <Code>/</Code>. Vale qualsiasi risposta HTTP, anche un 404: quello che si sta
      verificando è che la porta sia servita, non cosa risponde. L&apos;attesa iniziale è il tempo
      concesso prima di iniziare a sondare — un&apos;app che ci mette 40 secondi ad avviarsi senza
      quella sembra morta.
    </Hint>
  );
}

/** Why some variables have to exist before the build and not only after it. */
export function BuildEnvHint({ prefixes }: { prefixes: string[] }) {
  return (
    <Hint tone="warn" title="Variabili che il build compila dentro il bundle">
      Quelle con prefisso{" "}
      {prefixes.map((prefix, i) => (
        <span key={prefix}>
          {i > 0 && ", "}
          <Code>{prefix}</Code>
        </span>
      ))}{" "}
      vengono passate anche al build. I framework frontend le sostituiscono nel codice client al
      momento della compilazione: fornirle solo a runtime spedisce il valore vecchio, o fa fallire
      un Dockerfile che le pretende. Salvale prima di lanciare il deploy, non dopo.
    </Hint>
  );
}

/** The variables RunPanel sets on its own, and the ones it refuses to pass on. */
export function ManagedEnvHint({ runtimeType }: { runtimeType: string }) {
  const portAlwaysSet = runtimeType !== "docker" && runtimeType !== "compose";

  return (
    <Hint title="Quello che RunPanel mette da solo">
      A ogni deploy vengono aggiunte <Code>NODE_ENV=production</Code>, <Code>PORT</Code>{" "}
      {portAlwaysSet
        ? "dalla porta del progetto (3000 se non l'hai impostata)"
        : "se il progetto ha una porta impostata"}{" "}
      e le connection URL dei servizi collegati. Se dichiari qui una variabile con lo stesso nome,
      vince la tua. La configurazione del pannello — a partire da{" "}
      <Code>RUNPANEL_SECRET</Code>, la chiave con cui questi valori sono cifrati, e dal suo{" "}
      <Code>DATABASE_URL</Code> — viene invece tolta dall&apos;ambiente prima di consegnarlo al
      progetto: nessuna app deployata la vede.
    </Hint>
  );
}

/**
 * The shortcut nobody finds on their own: provision a database under Servizi
 * and its URL turns up in the app's environment without anyone copying it.
 */
export function ServiceLinkHint({ projectId }: { projectId?: string }) {
  return (
    <Hint tone="tip" icon="solar:link-circle-linear" title="Un database si collega da solo">
      Crea un database da{" "}
      {projectId ? (
        <Link href={`/services/new?projectId=${projectId}`} className="text-accent hover:underline">
          Aggiungi al progetto → Database
        </Link>
      ) : (
        <>Servizi → Nuovo servizio</>
      )}{" "}
      e al deploy successivo la sua connection URL entra nell&apos;ambiente dell&apos;app da sola:{" "}
      <Code>DATABASE_URL</Code> per PostgreSQL e MySQL, <Code>REDIS_URL</Code> per Redis,{" "}
      <Code>MONGODB_URL</Code> per MongoDB. Niente password da copiare, e l&apos;host giusto viene
      scelto in base al runtime.
    </Hint>
  );
}
