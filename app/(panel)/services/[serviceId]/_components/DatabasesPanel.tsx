"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CopyField } from "@/components/ui/CopyField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { buildConnectionString } from "@/lib/service-env";

/**
 * The databases inside one service.
 *
 * A service is a database server, and provisioning a second Postgres container
 * to hold a second database costs a gigabyte of RAM to express something the
 * engine already models. Each one gets its own URL; they share everything else
 * — container, volume, credentials — which is the part worth saying out loud
 * before someone treats them as isolated.
 */

interface ServiceDatabase {
  name: string;
  primary: boolean;
  managed: boolean;
  present: boolean;
}

/** Mirrors `databaseNameSchema`, so a bad name costs no round trip. */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function DatabasesPanel({
  serviceId,
  type,
  host,
  port,
  envKey,
  credentials,
}: {
  serviceId: string;
  type: string;
  /** The host the paste-ready URL should use — chosen by the page. */
  host: string;
  port: number;
  envKey: string;
  /** Null until the operator reveals them; the URLs stay hidden until then. */
  credentials: { user?: string; password?: string } | null;
}) {
  const { data, loading, refresh } = useResource<{
    supported: boolean;
    running: boolean;
    databases: ServiceDatabase[];
  }>(`/api/services/${serviceId}/databases`);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);

  if (type === "redis") {
    return (
      <Panel className="space-y-3">
        <PanelHeader title="Database" description="Come si separano i dati in Redis" />
        <Hint>
          Redis ha sedici database numerati da 0 a 15 e nessun nome: non c&apos;è niente da creare.
          Per usarne uno diverso cambia la cifra dopo l&apos;ultima <Code>/</Code> in{" "}
          <Code>{envKey}</Code> — <Code>…/0</Code> diventa <Code>…/1</Code>. Sono comunque lo stesso
          processo e la stessa memoria.
        </Hint>
      </Panel>
    );
  }

  if (data && !data.supported) return null;

  const databases = data?.databases ?? [];

  async function create() {
    const trimmed = name.trim();
    if (!NAME_PATTERN.test(trimmed)) {
      toast.error("Deve iniziare con una lettera minuscola; solo minuscole, numeri e underscore");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch(`/api/services/${serviceId}/databases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? "Creazione fallita");
        return;
      }
      toast.success(`Database "${trimmed}" creato`);
      setName("");
      refresh();
    } catch {
      toast.error("Creazione fallita");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Panel className="space-y-4">
        <PanelHeader
          title="Database"
          description="Più database nello stesso servizio, ognuno con la sua URL"
        />

        {loading && !data ? (
          <p className="text-muted text-sm">Carico…</p>
        ) : databases.length === 0 ? (
          <p className="text-muted text-sm">Nessun database.</p>
        ) : (
          <ul className="space-y-2">
            {databases.map((database) => {
              const url = credentials
                ? buildConnectionString(type, {
                    host,
                    port,
                    user: credentials.user,
                    password: credentials.password,
                    database: database.name,
                  })
                : null;

              return (
                <li
                  key={database.name}
                  className="border-border bg-surface-secondary space-y-2 rounded-[var(--radius)] border px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-foreground font-mono text-sm">{database.name}</span>
                    {database.primary && <span className="text-muted text-[11px]">principale</span>}
                    {!database.managed && !database.primary && (
                      <span className="text-muted text-[11px]">creato fuori dal pannello</span>
                    )}
                    {!database.present && (
                      <span className="text-warning text-[11px]">non trovato nel motore</span>
                    )}
                    {!database.primary && (
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        className="ml-auto"
                        aria-label={`Elimina ${database.name}`}
                        onPress={() => setConfirmDrop(database.name)}
                      >
                        <Icon icon="solar:trash-bin-trash-linear" width={16} className="text-danger" />
                      </Button>
                    )}
                  </div>

                  {url ? (
                    <CopyField value={`${envKey}=${url}`} secret />
                  ) : (
                    <p className="text-muted text-[11px]">
                      Mostra le connection string qui sopra per vedere la sua URL.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {data && !data.running && (
          <Hint tone="warn">
            Il servizio è fermo: l&apos;elenco è quello registrato dal pannello e non può essere
            confermato dal motore. Avvialo per crearne o eliminarne.
          </Hint>
        )}

        <div className="border-border flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <TextField value={name} onChange={setName}>
              <Label className="text-xs">Nuovo database</Label>
              <Input
                placeholder="staging"
                className="font-mono text-sm"
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
            </TextField>
          </div>
          <Button variant="outline" isPending={creating} onPress={create}>
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Crea
          </Button>
        </div>

        <FieldHint>
          Minuscole, numeri e underscore, iniziando con una lettera. Condividono container, volume,
          memoria e credenziali di questo servizio: un backup, uno stop o un&apos;eliminazione con i
          dati li prende tutti insieme.
          {type === "mongodb" && (
            <>
              {" "}
              MongoDB crea un database solo alla prima scrittura, quindi RunPanel ci mette dentro
              una collection vuota <Code>runpanel_init</Code> per renderlo davvero esistente.
            </>
          )}
        </FieldHint>
      </Panel>

      <ConfirmDialog
        isOpen={confirmDrop !== null}
        onOpenChange={(open) => !open && setConfirmDrop(null)}
        destructive
        title={`Eliminare il database "${confirmDrop}"?`}
        confirmLabel="Elimina"
        description="Le tabelle e i dati che contiene vengono persi. Gli altri database del servizio restano."
        onConfirm={async () => {
          const target = confirmDrop;
          if (!target) return;
          const res = await fetch(
            `/api/services/${serviceId}/databases/${encodeURIComponent(target)}`,
            { method: "DELETE" }
          );
          if (res.ok) {
            toast.success(`Database "${target}" eliminato`);
            refresh();
          } else {
            const body = await res.json().catch(() => ({}));
            toast.error(body.error ?? "Eliminazione fallita");
          }
        }}
      />
    </>
  );
}
