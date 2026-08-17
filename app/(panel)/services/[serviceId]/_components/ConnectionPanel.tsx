"use client";

import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CopyField } from "@/components/ui/CopyField";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { InfoTip } from "@/components/ui/Tooltip";
import { AccessSection } from "@/components/AccessSection";
import { buildConnectionString } from "@/lib/service-env";
import type { Credentials, From, Service } from "./types";

/**
 * How an application gets to this service — the question the page exists to
 * answer.
 *
 * The old version showed a "Reveal Credentials" button and a flat list of
 * key/value pairs, which left the actual question unanswered: what do I paste,
 * and where? Nothing said that a service attached to a project needs no pasting
 * at all. So people copied a localhost URL into their env by hand, which then
 * took precedence over the one RunPanel would have injected, and stopped
 * working the moment the app was containerised.
 */

/**
 * The same instance, from three places.
 *
 * These were four CopyFields stacked with a paragraph of explanation each, for
 * one value. The difference between them is genuinely the thing people get
 * wrong — a container name does not resolve outside the project network, and
 * the published port is not the port inside — but presenting all of it at once
 * meant reading four explanations to find out which single line was yours.
 */
const FROM_OPTIONS = [
  { value: "network" as const, label: "Dall'app del progetto" },
  { value: "container" as const, label: "Da un container" },
  { value: "host" as const, label: "Da questa macchina" },
];

const FROM_NOTES: Record<From, (service: Service) => React.ReactNode> = {
  network: (service) => (
    <>
      Host il nome del container, porta <Code>{String(service.internalPort)}</Code> — quella interna,
      non quella pubblicata. È esattamente la riga che RunPanel inietta.
    </>
  ),
  /*
    `network` è offerta solo quando l'app del progetto ci arriva davvero per
    nome del container: gira in un container, sulla rete del progetto. Prima
    veniva proposta — e preselezionata — a qualunque servizio collegato, con
    sotto la frase «è esattamente la riga che RunPanel inietta». Per un progetto
    sotto PM2 quella frase era falsa e quella riga non funziona: il nome del
    container non si risolve fuori da una rete Docker, e chi la copiava
    otteneva `could not translate host name`.
  */
  container: (service) => (
    <>
      <Code>host.docker.internal</Code> è un alias che RunPanel aggiunge a ogni container: il
      traffico esce e rientra dalla porta pubblicata (<Code>{String(service.port)}</Code>). Funziona
      senza reti condivise. Con <Code>network: host</Code> usa <Code>localhost</Code>.
    </>
  ),
  host: (service) => (
    <>
      Per un processo nativo (PM2) e per i tuoi client: psql, TablePlus, uno script sul server. Da
      fuori dalla macchina, per un database, la risposta giusta è quasi sempre un tunnel SSH.
      {service.project_id && !service.reachedByContainerName && (
        <>
          {" "}
          È anche esattamente la riga che RunPanel inietta in <Code>{service.envKey}</Code>: l&apos;app
          di questo progetto non gira in un container sulla rete del progetto, quindi ci arriva da
          qui.
        </>
      )}
    </>
  ),
};

export function ConnectionPanel({
  service,
  project,
  creds,
  from,
  onFromChange,
  onReveal,
  onSaved,
}: {
  service: Service;
  project: { id: string; name: string } | null;
  /** Null until the operator reveals them; the URLs stay hidden until then. */
  creds: Credentials | null;
  from: From;
  onFromChange: (next: From) => void;
  onReveal: () => void;
  onSaved: () => void;
}) {
  // Three ways in, and which one is right depends on where the caller runs.
  const hostUrl = buildConnectionString(service.type, {
    host: "localhost",
    port: service.port,
    ...(creds ?? {}),
  });

  // Reaches the published port from inside any container RunPanel starts: both
  // drivers pass `--add-host=host.docker.internal:host-gateway`. It is the one
  // address that does not depend on a shared network, which is what makes it
  // the right thing to hand someone with a service that has no project.
  const gatewayUrl = buildConnectionString(service.type, {
    host: "host.docker.internal",
    port: service.port,
    ...(creds ?? {}),
  });

  // Only resolves for a container on the same network, and the only network a
  // service ever joins is its project's.
  const networkUrl = buildConnectionString(service.type, {
    host: service.containerName,
    port: service.internalPort,
    ...(creds ?? {}),
  });

  const url = from === "network" ? networkUrl : from === "container" ? gatewayUrl : hostUrl;

  return (
    <div className="space-y-4">
      {service.project_id ? (
        <Hint tone="tip" icon="solar:link-circle-linear" title="Già collegato">
          A ogni deploy{" "}
          {project ? (
            <Link href={`/projects/${service.project_id}`} className="text-accent hover:underline">
              {project.name}
            </Link>
          ) : (
            "il progetto"
          )}{" "}
          riceve <Code>{service.envKey}</Code> con queste credenziali, se l&apos;iniezione è accesa: non
          serve copiarla nelle variabili. L&apos;interruttore è nella scheda Variabili del progetto.
        </Hint>
      ) : (
        <Hint icon="solar:database-linear" title="Servizio autonomo">
          Non appartiene a nessun progetto, quindi RunPanel non inietta niente da nessuna parte —
          ed è utilizzabile da quanti progetti vuoi. Copia la riga pronta qui sotto e incollala
          tra le variabili di chi lo deve usare.
        </Hint>
      )}

      <Panel className="space-y-4">
        <PanelHeader
          title="Come ci si collega"
          description="Un solo indirizzo, visto da dove chiami"
          actions={
            <InfoTip title="Perché cambia">
              È la stessa istanza: cambia solo la strada per arrivarci. Dentro la rete del
              progetto si risolve per nome del container e la porta è quella interna; da
              fuori si passa dalla porta pubblicata sull&apos;host.
            </InfoTip>
          }
        />

        {creds ? (
          <>
            {/*
              Four CopyFields with a paragraph each, for what is one value seen
              from four places. The reader had to read all four to work out
              which one was theirs; now they say where they are calling from
              and get the answer.
            */}
            <Segmented
              label="Da dove ti colleghi"
              value={from}
              onChange={onFromChange}
              options={FROM_OPTIONS.filter(
                (o) => o.value !== "network" || service.reachedByContainerName
              )}
            />

            <div>
              <CopyField label="Riga pronta per le variabili" value={`${service.envKey}=${url}`} secret />
              <FieldHint>{FROM_NOTES[from](service)}</FieldHint>
            </div>

            <Section title="Credenziali" summary="Utente, database, password e nome del container">
              <div className="grid gap-3 sm:grid-cols-2">
                {creds.user && <CopyField label="Utente" value={creds.user} />}
                {creds.database && <CopyField label="Database" value={creds.database} />}
                {creds.password && <CopyField label="Password" value={creds.password} secret />}
                <CopyField label="Nome del container" value={service.containerName} />
              </div>
              {!service.project_id && (
                <FieldHint>
                  Il nome del container serve per <Code>docker exec</Code>: senza progetto non
                  c&apos;è una rete condivisa, quindi non è un host che un altro container
                  risolve.
                </FieldHint>
              )}
            </Section>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <CopyField label="Nome del container" value={service.containerName} />
              <CopyField
                label="Porta"
                value={`${service.port} sull'host, ${service.internalPort} nel container`}
              />
            </div>
            <Button variant="secondary" onPress={onReveal}>
              <Icon icon="solar:eye-linear" width={18} aria-hidden />
              Mostra le connection string
            </Button>
            <FieldHint>
              Restano nascoste finché non le chiedi: contengono la password in chiaro.
            </FieldHint>
          </>
        )}
      </Panel>

      {/*
        Here, and not lower down: it answers the same question as the panel
        above — how one reaches this service — and it has to be read before
        the per-database URLs, not after them.
      */}
      <AccessSection
        kind="service"
        targetId={service.id}
        name={service.name}
        publicPort={service.port}
        access={service.access}
        gate={service.gate}
        onSaved={onSaved}
      />
    </div>
  );
}
