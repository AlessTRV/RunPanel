"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { CopyField } from "@/components/ui/CopyField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
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

export default function ServiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const serviceId = params.serviceId as string;

  const { data: service, loading, refresh } = useResource<Service>(
    `/api/services/${serviceId}`,
    { intervalMs: 5000 }
  );

  const [creds, setCreds] = useState<Credentials | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  /** What to paste into someone's environment, key included. */
  const pasteLine = `${service.envKey}=${service.project_id ? networkUrl : gatewayUrl}`;

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
            riceve <Code>{service.envKey}</Code> con queste credenziali: non serve copiarla nelle
            variabili. Se ne dichiari una con lo stesso nome, RunPanel lascia stare la tua.
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
            description="La stessa istanza, indirizzi diversi a seconda di chi chiama"
          />

          {creds ? (
            <>
              <div>
                <CopyField label="Riga pronta per le variabili" value={pasteLine} secret />
                <FieldHint>
                  Incollala così com&apos;è tra le variabili del progetto che deve usare questo
                  servizio.
                </FieldHint>
              </div>

              {service.project_id && (
                <div>
                  <CopyField label={`Da un container sulla rete ${service.networkName ?? "del progetto"}`} value={networkUrl} secret />
                  <FieldHint>
                    È quella che RunPanel inietta quando l&apos;app gira in un container sulla rete
                    del progetto. L&apos;host è il nome del container e la porta è quella interna:{" "}
                    <Code>{service.internalPort}</Code>, non quella pubblicata sull&apos;host.
                  </FieldHint>
                </div>
              )}

              <div>
                <CopyField label="Da un qualsiasi container su questa macchina" value={gatewayUrl} secret />
                <FieldHint>
                  <Code>host.docker.internal</Code> è un alias che RunPanel aggiunge a ogni
                  container che avvia, e punta alla macchina host: il traffico esce dal container e
                  rientra dalla porta pubblicata, quindi qui la porta è quella dell&apos;host (
                  <Code>{service.port}</Code>). Funziona senza condividere nessuna rete — è la
                  strada giusta quando il servizio non appartiene al progetto che lo chiama. Con{" "}
                  <Code>network: host</Code> usa invece <Code>localhost</Code>.
                </FieldHint>
              </div>

              <div>
                <CopyField label="Dalla macchina host — client esterni, processi nativi" value={hostUrl} secret />
                <FieldHint>
                  Questa vale per un&apos;app avviata come processo nativo (PM2) e per i tuoi client:
                  psql, TablePlus, uno script sul server. Da fuori dalla macchina la porta deve essere
                  raggiungibile, e per un database esposto su internet la risposta giusta è quasi
                  sempre un tunnel SSH.
                </FieldHint>
              </div>

              <div className="border-border grid gap-3 border-t pt-4 sm:grid-cols-2">
                {creds.user && <CopyField label="Utente" value={creds.user} />}
                {creds.database && <CopyField label="Database" value={creds.database} />}
                {creds.password && <CopyField label="Password" value={creds.password} secret />}
                <CopyField label="Nome del container" value={service.containerName} />
              </div>

              {!service.project_id && (
                <FieldHint>
                  Il nome del container serve per <Code>docker exec</Code>: non è un host che un
                  altro container può risolvere, perché senza progetto non c&apos;è una rete
                  condivisa con nessuno.
                </FieldHint>
              )}
            </>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <CopyField label="Nome del container" value={service.containerName} />
                <CopyField
                  label="Porta"
                  value={`${service.port} sull'host → ${service.internalPort} nel container`}
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

        <Panel className="space-y-3">
          <PanelHeader title="Dati" description="Dove finisce quello che il servizio scrive" />
          <p className="text-muted text-xs leading-relaxed">
            I dati stanno in un volume Docker dedicato, con le etichette di proprietà di RunPanel —
            fermare o ricreare il container non li tocca, e tutti i database di questo servizio ci
            stanno dentro insieme. Vengono eliminati solo se lo chiedi esplicitamente eliminando il
            servizio; se un volume resta indietro perché la riga è sparita, la pagina Storage lo
            elenca tra le risorse orfane.
          </p>
        </Panel>

        <Panel className="border-danger/30 space-y-3">
          <PanelHeader title="Elimina il servizio" description="Il container viene rimosso subito" />
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={deleteData}
              onChange={(e) => setDeleteData(e.target.checked)}
              className="accent-danger mt-0.5 size-4"
            />
            <span className="text-muted text-xs leading-relaxed">
              Elimina anche il volume con i dati.{" "}
              <strong className="text-foreground">Non è recuperabile.</strong> Senza questa spunta il
              volume resta: un servizio ricreato con lo stesso nome ritrova i dati di prima.
            </span>
          </label>
          <div>
            <Button variant="danger" onPress={() => setConfirmDelete(true)}>
              <Icon icon="solar:trash-bin-trash-linear" width={18} aria-hidden />
              Elimina servizio
            </Button>
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        destructive
        title={`Eliminare "${service.name}"?`}
        confirmLabel="Elimina"
        description={
          deleteData
            ? "Il container e il volume con i dati vengono eliminati. I dati non sono recuperabili."
            : "Il container viene eliminato. Il volume con i dati resta e può essere riutilizzato da un servizio con lo stesso nome."
        }
        onConfirm={async () => {
          const res = await fetch(
            `/api/services/${serviceId}${deleteData ? "?deleteData=true" : ""}`,
            { method: "DELETE" }
          );
          if (res.ok) {
            toast.success("Servizio eliminato");
            router.push("/services");
          } else {
            toast.error("Eliminazione fallita");
          }
        }}
      />
    </>
  );
}
