"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DangerZone } from "@/components/ui/DangerAction";
import { DatabasesPanel } from "./DatabasesPanel";
import type { Credentials, From, Service } from "./types";

/**
 * Everything about the data this service holds: the databases inside it, and
 * the one action that removes them.
 *
 * The two are together because the delete confirmation asks about the volume,
 * and the volume is what the panel above has just been describing. Read one
 * screen apart they were trivia and a checkbox; read together they are a
 * choice.
 */
export function DataSection({
  service,
  from,
  creds,
  onDeleted,
}: {
  service: Service;
  from: From;
  creds: Credentials | null;
  onDeleted: () => void;
}) {
  const [deleteData, setDeleteData] = useState(false);

  return (
    <div className="space-y-4">
      <DatabasesPanel
        serviceId={service.id}
        type={service.type}
        /*
          The same host the paste-ready line uses, so a per-database URL is not
          quietly built for a different caller than the one it is for. It
          follows the chosen viewpoint: it used to be pinned to the container
          name for every linked service, which handed a PM2 project a hostname
          that does not resolve.
        */
        host={
          from === "network"
            ? service.containerName
            : from === "container"
              ? "host.docker.internal"
              : "localhost"
        }
        port={from === "network" ? service.internalPort : service.port}
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
            `/api/services/${service.id}${deleteData ? "?deleteData=true" : ""}`,
            { method: "DELETE" }
          );
          if (res.ok) {
            toast.success("Servizio eliminato");
            onDeleted();
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
  );
}
