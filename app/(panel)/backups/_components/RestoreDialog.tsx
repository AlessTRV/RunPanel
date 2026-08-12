"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertDialog, Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Hint } from "@/components/ui/Hint";
import { useResource } from "@/lib/hooks/useResource";
import { formatBytes } from "@/lib/utils";
import type { ArtifactView, TargetCatalog } from "./types";

/**
 * The confirmation in front of the only operation that can destroy production
 * data.
 *
 * Three things are deliberate. The operator picks, per element, where it goes —
 * defaulting to where it came from, but never assuming. The confirmation asks
 * for the *real name* of what is about to be overwritten rather than a token
 * like DELETE, because muscle memory defeats a token. And the safety backup is
 * on unless someone goes out of their way to turn it off.
 */

const KIND_LABELS: Record<string, string> = {
  "service-db": "Database",
  "panel-store": "Store del pannello",
  "project-config": "Configurazione",
  "project-volume": "Volume",
  "project-repo": "Repository",
};

interface Choice {
  action: "restore" | "skip";
  targetId: string;
}

export function RestoreDialog({
  runId,
  artifacts,
  isOpen,
  onOpenChange,
}: {
  runId: string;
  artifacts: ArtifactView[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const catalog = useResource<TargetCatalog>(isOpen ? "/api/backups/targets" : null);

  const restorable = useMemo(
    () => artifacts.filter((artifact) => artifact.status === "ok"),
    [artifacts]
  );

  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      artifacts
        .filter((artifact) => artifact.status === "ok")
        .map((artifact) => [
          artifact.id,
          { action: "skip" as const, targetId: artifact.refId ?? "" },
        ])
    )
  );
  const [skipSafety, setSkipSafety] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pending, setPending] = useState(false);

  const selected = restorable.filter((artifact) => choices[artifact.id]?.action === "restore");
  // The name the operator has to type: the first thing that will be overwritten.
  const requiredName = selected[0]?.refName ?? "";
  const confirmed = confirmText.trim() === requiredName;

  function optionsFor(artifact: ArtifactView) {
    if (artifact.kind === "service-db") {
      const engine = String(artifact.meta?.engine ?? "");
      return (catalog.data?.services ?? [])
        .filter((service) => !engine || service.type === engine)
        .map((service) => ({ id: service.id, label: `${service.name} (${service.type})` }));
    }
    if (artifact.kind.startsWith("project-")) {
      return (catalog.data?.projects ?? []).map((project) => ({
        id: project.id,
        label: project.slug,
      }));
    }
    return [];
  }

  async function submit() {
    if (selected.length === 0) {
      toast.error("Scegli almeno un elemento da ripristinare");
      return;
    }
    if (!confirmed) {
      toast.error(`Per confermare, scrivi esattamente: ${requiredName}`);
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          confirm: confirmText.trim(),
          skipSafetyBackup: skipSafety,
          targets: restorable.map((artifact) => ({
            artifactId: artifact.id,
            action: choices[artifact.id]?.action ?? "skip",
            ...(choices[artifact.id]?.targetId
              ? { targetId: choices[artifact.id].targetId }
              : {}),
          })),
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Avvio del ripristino non riuscito");
        return;
      }

      toast.success("Ripristino avviato");
      onOpenChange(false);
      router.push(`/backups/restore/${body.restoreId}`);
    } catch {
      toast.error("Avvio del ripristino non riuscito");
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (pending) return;
        onOpenChange(open);
      }}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog className="max-w-2xl">
          <AlertDialog.Header>
            <AlertDialog.Heading>Ripristinare da questo backup</AlertDialog.Heading>
          </AlertDialog.Header>

          <AlertDialog.Body>
            <p className="text-muted text-sm">
              Scegli cosa rimettere e dove. Quello che c&apos;è adesso al posto scelto viene
              sovrascritto.
            </p>

            <ul className="border-border mt-4 divide-y divide-[var(--color-border)] rounded-[var(--radius)] border">
              {restorable.map((artifact) => {
                const choice = choices[artifact.id];
                const options = optionsFor(artifact);
                const on = choice?.action === "restore";

                return (
                  <li key={artifact.id} className="p-3">
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={on}
                        onChange={(event) =>
                          setChoices((current) => ({
                            ...current,
                            [artifact.id]: {
                              action: event.target.checked ? "restore" : "skip",
                              targetId: current[artifact.id]?.targetId ?? artifact.refId ?? "",
                            },
                          }))
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate">{artifact.refName}</span>
                        <span className="text-muted text-xs">
                          {KIND_LABELS[artifact.kind] ?? artifact.kind} ·{" "}
                          {formatBytes(artifact.bytes)}
                        </span>
                      </span>
                    </label>

                    {on && options.length > 0 && (
                      <div className="mt-2 pl-6">
                        <select
                          value={choice.targetId}
                          onChange={(event) =>
                            setChoices((current) => ({
                              ...current,
                              [artifact.id]: { action: "restore", targetId: event.target.value },
                            }))
                          }
                          className="border-border bg-surface text-foreground h-8 w-full rounded-[var(--radius)] border px-2 text-xs"
                        >
                          <option value="">— scegli la destinazione —</option>
                          {options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {on && artifact.kind === "panel-store" && (
                      <Hint tone="warn" className="mt-2 ml-6">
                        Lo store del pannello viene messo in servizio al prossimo riavvio, non
                        adesso: un file aperto da questo processo non si può sostituire mentre gira.
                        Quello attuale resta conservato accanto.
                      </Hint>
                    )}
                  </li>
                );
              })}
            </ul>

            <label className="mt-4 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={skipSafety}
                onChange={(event) => setSkipSafety(event.target.checked)}
              />
              <span>
                <span className="text-foreground">Procedi anche senza backup di sicurezza</span>
                <span className="text-muted block text-xs">
                  Di norma il pannello salva prima quello che sta per sovrascrivere, e si ferma se
                  non ci riesce. Togliere questa rete significa che un ripristino sbagliato non ha
                  ritorno.
                </span>
              </span>
            </label>

            {selected.length > 0 && (
              <div className="mt-4">
                <TextField value={confirmText} onChange={setConfirmText}>
                  <Label>
                    Per confermare, scrivi <strong>{requiredName}</strong>
                  </Label>
                  <Input placeholder={requiredName} />
                </TextField>
                {selected.length > 1 && (
                  <p className="text-muted mt-1 text-xs">
                    Verranno sovrascritti anche:{" "}
                    {selected.slice(1).map((artifact) => artifact.refName).join(", ")}
                  </p>
                )}
              </div>
            )}
          </AlertDialog.Body>

          <AlertDialog.Footer className="justify-end gap-2">
            <Button variant="ghost" isDisabled={pending} onPress={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button
              variant="danger"
              isPending={pending}
              isDisabled={!confirmed || selected.length === 0}
              onPress={submit}
            >
              <Icon icon="solar:restart-linear" width={16} aria-hidden />
              Ripristina
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
