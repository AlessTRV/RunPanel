"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { CopyField } from "@/components/ui/CopyField";
import { DangerZone } from "@/components/ui/DangerAction";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { InfoTip } from "@/components/ui/Tooltip";
import { StatusBadge } from "@/components/StatusBadge";
import { buildConnectionString, serviceLabel } from "@/lib/service-env";
import { DatabasesPanel } from "./_components/DatabasesPanel";

/**
 * A provisioned service, and — the point of the page — how an application gets
 * to it.
 *
 * The old version showed a "Reveal Credentials" button and a flat list of
 * key/value pairs, which left the actual question unanswered: what do I paste,
 * and where? Nothing said that a service attached to a project needs no pasting
 * at all. So people copied a localhost URL into their env by hand, which then
 * took precedence over the one RunPanel would have injected, and stopped
 * working the moment the app was containerised.
 */

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
  credentials: string;
  project_id: string | null;
  created_at: string;
  /** Resolved server-side, from the service template and the owning project. */
  containerName: string;
  internalPort: number;
  envKey: string;
  projectSlug: string | null;
  networkName: string | null;
}

interface Credentials {
  user?: string;
  password?: string;
  database?: string;
}

/**
 * The same instance, from three places.
 *
 * These were four CopyFields stacked with a paragraph of explanation each, for
 * one value. The difference between them is genuinely the thing people get
 * wrong — a container name does not resolve outside the project network, and
 * the published port is not the port inside — but presenting all of it at once
 * meant reading four explanations to find out which single line was yours.
 */
type From = "network" | "container" | "host";

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
  container: (service) => (
    <>
      <Code>host.docker.internal</Code> è un alias che RunPanel aggiunge a ogni container: il
      traffico esce e rientra dalla porta pubblicata (<Code>{String(service.port)}</Code>). Funziona
      senza reti condivise. Con <Code>network: host</Code> usa <Code>localhost</Code>.
    </>
  ),
  host: () => (
    <>
      Per un processo nativo (PM2) e per i tuoi client: psql, TablePlus, uno script sul server. Da
      fuori dalla macchina, per un database, la risposta giusta è quasi sempre un tunnel SSH.
    </>
  ),
};

export default function ServiceDetailPage() {
  const poll5000 = usePollInterval(5000);
  const params = useParams();
  const router = useRouter();
  const serviceId = params.serviceId as string;

  const { data: service, loading, refresh } = useResource<Service>(
    `/api/services/${serviceId}`,
    { intervalMs: poll5000 }
  );

  const [creds, setCreds] = useState<Credentials | null>(null);
  // Null until chosen, so the sensible default can depend on data that has not
  // loaded yet when the hook runs.
  const [fromChoice, setFromChoice] = useState<From | null>(null);
  const [deleteData, setDeleteData] = useState(false);

  // The project the service belongs to, if any: without one nothing is injected
  // anywhere, and that is worth saying out loud rather than leaving to be
  // discovered after a deploy.
  const { data: project } = useResource<{ id: string; name: string }>(
    service?.project_id ? `/api/projects/${service.project_id}` : null
  );

  async function revealCredentials() {
    const res = await fetch(`/api/services/${serviceId}?reveal=true`);
    if (!res.ok) {
      toast.error("Impossibile leggere le credenziali");
      return;
    }
    const data = await res.json();
    try {
      setCreds(JSON.parse(data.credentials));
    } catch {
      toast.error("Credenziali illeggibili");
    }
  }

  async function handleControl(action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(`/api/services/${serviceId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json();
        toast.error(body.error ?? `Azione "${action}" fallita`);
        return;
      }
      toast.success(`Azione "${action}" eseguita`);
      refresh();
    } catch {
      toast.error(`Azione "${action}" fallita`);
    }
  }

  if (loading && !service) return <PageSkeleton />;

  if (!service) {
    return (
      <>
        <PageHeader title="Servizio" />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Servizio non trovato"
            description="È stato eliminato, oppure il link non è più valido."
            action={
              <Link href="/services" className="text-accent text-sm hover:underline">
                Torna ai servizi
              </Link>
            }
          />
        </Panel>
      </>
    );
  }

  const running = service.status === "running";
  const label = serviceLabel(service.type);
  const from: From = fromChoice ?? (service.project_id ? "network" : "container");

  // Three ways in, and which one is right depends on where the caller runs.
  // Shown together because the difference is exactly what people get wrong.
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
    <>
      <PageHeader
        title={service.name}
        description={`${label} ${service.version} · porta ${service.port} sull'host`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={service.status} />
            {running ? (
              <>
                <Button variant="outline" size="sm" onPress={() => handleControl("restart")}>
                  <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                  Riavvia
                </Button>
                <Button variant="outline" size="sm" onPress={() => handleControl("stop")}>
                  <Icon icon="solar:stop-linear" width={16} className="text-danger" aria-hidden />
                  Ferma
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" onPress={() => handleControl("start")}>
                <Icon icon="solar:play-linear" width={16} aria-hidden />
                Avvia
              </Button>
            )}
          </div>
        }
      />

      <div className="max-w-2xl space-y-4">
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
                onChange={setFromChoice}
                options={FROM_OPTIONS.filter((o) => o.value !== "network" || Boolean(service.project_id))}
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
              <Button variant="secondary" onPress={revealCredentials}>
                <Icon icon="solar:eye-linear" width={18} aria-hidden />
                Mostra le connection string
              </Button>
              <FieldHint>
                Restano nascoste finché non le chiedi: contengono la password in chiaro.
              </FieldHint>
            </>
          )}
        </Panel>

        <DatabasesPanel
          serviceId={service.id}
          type={service.type}
          // The same host the paste-ready line above uses, so a per-database URL
          // is not quietly built for a different caller than the one it is for.
          host={service.project_id ? service.containerName : "host.docker.internal"}
          port={service.project_id ? service.internalPort : service.port}
          envKey={service.envKey}
          credentials={creds}
        />

        {/*
          The "Dati" panel that used to sit above this is gone. Its one
          operational fact — the data lives in a volume, and deleting it is
          opt-in — is here instead, at the moment that fact decides something.
          Read while scrolling past, it was trivia; read here, it is the choice.
        */}
        <DangerZone
          title="Elimina il servizio"
          description="Il container viene rimosso subito"
          actionLabel="Elimina servizio"
          confirm={{
            title: `Eliminare "${service.name}"?`,
            confirmLabel: "Elimina",
            description: deleteData
              ? "Il container e il volume con i dati vengono eliminati. I dati non sono recuperabili."
              : "Il container viene eliminato. Il volume con i dati resta, e un servizio ricreato con lo stesso nome lo ritrova.",
          }}
          onConfirm={async () => {
            const res = await fetch(
              `/api/services/${serviceId}${deleteData ? "?deleteData=true" : ""}`,
              { method: "DELETE" }
            );
            if (res.ok) {
              toast.success("Servizio eliminato");
              router.push("/services");
            } else {
              toast.error("Eliminazione non riuscita");
            }
          }}
        >
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={deleteData}
              onChange={(e) => setDeleteData(e.target.checked)}
              className="accent-danger mt-0.5 size-4"
            />
            <span className="text-muted text-xs leading-relaxed">
              Elimina anche il volume con i dati.{" "}
              <strong className="text-foreground">Non è recuperabile.</strong> I dati di questo
              servizio stanno in un volume Docker dedicato: senza la spunta resta lì, e un servizio
              ricreato con lo stesso nome li ritrova.
            </span>
          </label>
        </DangerZone>
      </div>

    </>
  );
}
