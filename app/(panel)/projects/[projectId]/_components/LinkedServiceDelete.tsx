"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { DeleteButton } from "@/components/ui/DangerAction";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { serviceLabel } from "@/lib/service-env";
import { serviceDisplayName } from "@/lib/service-name";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";

export interface LinkedServiceRow {
  id: string;
  name: string;
  type: string;
  project_id: string | null;
}

/**
 * One linked service, deletable from the project's own settings.
 *
 * The same choice the service's page offers — container only, or container and
 * data — but reachable from where the project is being taken apart, so
 * "remove this one database and keep the rest" does not require leaving the
 * page. The checkbox lives in the dialog rather than beside the row: a row of
 * pre-armed "also delete the data" switches is a row of accidents.
 */
export function LinkedServiceDelete({
  service,
  onDeleted,
}: {
  service: LinkedServiceRow;
  onDeleted: () => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const [deleteData, setDeleteData] = useState(false);

  return (
    <li className="flex items-center gap-2">
      <Icon
        icon={service.type === "redis" ? "solar:bolt-linear" : "solar:database-linear"}
        width={16}
        className="text-muted shrink-0"
        aria-hidden
      />
      <Link
        href={href(`/services/${service.id}`)}
        className="text-foreground hover:text-accent min-w-0 truncate text-sm transition-colors"
      >
        {serviceDisplayName(service)}
      </Link>
      <span className="text-muted text-meta">{serviceLabel(service.type)}</span>
      <span className="ml-auto shrink-0">
        <DeleteButton
          label={`Elimina ${serviceDisplayName(service)}`}
          // Cancel must disarm it: reopening should never find "delete the
          // volume" already ticked.
          onClose={() => setDeleteData(false)}
          confirm={{
            title: `Eliminare "${serviceDisplayName(service)}"?`,
            confirmLabel: "Elimina",
            description: (
              <>
                {deleteData
                  ? "Il container e il volume con i dati vengono eliminati. I dati non sono recuperabili."
                  : "Il container viene eliminato. Il volume con i dati resta, e un servizio ricreato con lo stesso nome in questo progetto lo ritrova."}
                <CheckboxField
                  className="mt-3"
                  isSelected={deleteData}
                  onChange={setDeleteData}
                  label={
                    <span className="text-xs leading-relaxed">
                      Elimina anche il volume con i dati.{" "}
                      <strong className="text-foreground">Non è recuperabile.</strong>
                    </span>
                  }
                />
              </>
            ),
          }}
          onConfirm={async () => {
            const res = await fetch(
              api(`/api/services/${service.id}${deleteData ? "?deleteData=true" : ""}`),
              { method: "DELETE" }
            );
            if (res.ok) {
              toast.success(`${serviceDisplayName(service)} eliminato`);
              setDeleteData(false);
              onDeleted();
            } else {
              toast.error("Eliminazione non riuscita");
            }
          }}
        />
      </span>
    </li>
  );
}
