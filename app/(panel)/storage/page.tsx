"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { formatBytes } from "@/lib/format";

interface UsageEntry {
  type: string;
  total: number;
  active: number;
  size: string;
  reclaimable: string;
}

interface ImageInfo {
  id: string;
  repository: string;
  tag: string;
  createdAt: string;
  size: string;
}

interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
}

interface Orphans {
  containers: string[];
  images: string[];
  volumes: string[];
  networks: string[];
}

interface StorageData {
  dockerAvailable: boolean;
  usage: UsageEntry[];
  images: ImageInfo[];
  volumes: VolumeInfo[];
  orphans: Orphans;
  retention: { imagesPerProject: number; buildCacheHours: number };
}

export default function StoragePage() {
  const [data, setData] = useState<StorageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [confirmOrphans, setConfirmOrphans] = useState(false);
  const [keepImages, setKeepImages] = useState<number | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    // State is set from the promise callbacks, never synchronously in the
    // effect body — that is what turns a fetch-on-mount into cascading renders.
    return fetch("/api/storage", { signal })
      .then((res) => {
        if (!res.ok) throw new Error("request failed");
        return res.json();
      })
      .then((json: StorageData) => {
        setData(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast.error("Impossibile leggere lo stato dello storage");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function runSweep(removeOrphans: boolean) {
    setCleaning(true);
    try {
      const res = await fetch("/api/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          removeOrphans,
          ...(keepImages != null && data
            ? { retention: { imagesPerProject: keepImages, buildCacheHours: data.retention.buildCacheHours } }
            : {}),
        }),
      });
      if (!res.ok) throw new Error();

      const result = await res.json();
      if (result.skipped) {
        toast.error(result.skipped);
      } else {
        const removed =
          result.prunedImageTags.length +
          result.containers.length +
          result.images.length +
          result.volumes.length +
          result.networks.length;
        toast.success(
          `Recuperati ${formatBytes(result.reclaimedBytes)} · ${removed} risorse rimosse`
        );
      }
      await load();
    } catch {
      toast.error("Pulizia non riuscita");
    } finally {
      setCleaning(false);
    }
    // Nothing after this point — `load` already refreshed the view.
  }

  // Render the page shell straight away and let the panels fill in. Blocking
  // the whole route on a fetch is what makes navigation feel slow even when the
  // request itself is quick.
  if (loading && !data) {
    return (
      <>
        <PageHeader title="Storage" description="Immagini, volumi e cache che RunPanel possiede su questo host" />
        <div className="space-y-4">
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-28" />
          <div className="grid gap-4 lg:grid-cols-2">
            <SkeletonBlock className="h-40" />
            <SkeletonBlock className="h-40" />
          </div>
        </div>
      </>
    );
  }

  if (!data?.dockerAvailable) {
    return (
      <>
        <PageHeader title="Storage" description="Spazio occupato da RunPanel su Docker" />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Docker non raggiungibile"
            description="Le funzioni di pulizia richiedono un daemon Docker attivo su questa macchina."
          />
        </Panel>
      </>
    );
  }

  const orphanCount =
    data.orphans.containers.length +
    data.orphans.images.length +
    data.orphans.volumes.length +
    data.orphans.networks.length;

  return (
    <>
      <PageHeader
        title="Storage"
        description="Immagini, volumi e cache che RunPanel possiede su questo host"
        actions={
          <Button variant="secondary" size="sm" isPending={cleaning} onPress={() => runSweep(false)}>
            <Icon icon="solar:broom-linear" width={16} aria-hidden />
            Pulisci ora
          </Button>
        }
      />

      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title="Utilizzo Docker"
            description="Riepilogo di docker system df, su tutto il daemon"
          />
          {/*
            A table on a wide screen, a list of cards on a phone.

            Five columns of numbers do not survive 360px: they either wrap into
            unreadable stacks or force a horizontal scroll on the page body. The
            same data reads fine as one block per row, with the label attached
            to each number instead of five columns up.
          */}
          <div className="mt-3 hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted border-border border-b text-left text-xs">
                  <th className="py-2 pr-4 font-medium">Tipo</th>
                  <th className="py-2 pr-4 font-medium">Totale</th>
                  <th className="py-2 pr-4 font-medium">Attivi</th>
                  <th className="py-2 pr-4 font-medium">Dimensione</th>
                  <th className="py-2 font-medium">Recuperabile</th>
                </tr>
              </thead>
              <tbody>
                {data.usage.map((row) => (
                  <tr key={row.type} className="border-border/50 border-b last:border-0">
                    <td className="text-foreground py-2 pr-4">{row.type}</td>
                    <td className="text-muted py-2 pr-4 tabular-nums">{row.total}</td>
                    <td className="text-muted py-2 pr-4 tabular-nums">{row.active}</td>
                    <td className="text-foreground py-2 pr-4 font-mono text-xs">{row.size}</td>
                    <td className="text-warning py-2 font-mono text-xs">{row.reclaimable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="divide-border mt-3 divide-y sm:hidden">
            {data.usage.map((row) => (
              <li key={row.type} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-foreground text-sm">{row.type}</span>
                  <span className="text-foreground font-mono text-xs">{row.size}</span>
                </div>
                <p className="text-muted text-meta mt-0.5">
                  {row.active} attivi su {row.total}
                  {row.reclaimable && row.reclaimable !== "0B" ? (
                    <span className="text-warning"> · {row.reclaimable} recuperabili</span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader
            title="Risorse orfane"
            description="Possedute da RunPanel ma senza un progetto o un servizio corrispondente nel database"
            actions={
              orphanCount > 0 ? (
                <Button
                  variant="danger"
                  size="sm"
                  isDisabled={cleaning}
                  onPress={() => setConfirmOrphans(true)}
                >
                  Rimuovi {orphanCount}
                </Button>
              ) : undefined
            }
          />

          {orphanCount === 0 ? (
            <p className="text-muted mt-3 text-sm">Nessuna risorsa orfana.</p>
          ) : (
            <div className="mt-3 space-y-3 text-sm">
              {(
                [
                  ["Container", data.orphans.containers],
                  ["Immagini", data.orphans.images],
                  ["Volumi", data.orphans.volumes],
                  ["Network", data.orphans.networks],
                ] as const
              )
                .filter(([, items]) => items.length > 0)
                .map(([label, items]) => (
                  <div key={label}>
                    <p className="text-muted mb-1 text-xs font-medium">
                      {label} ({items.length})
                    </p>
                    <ul className="space-y-1">
                      {items.map((item) => (
                        <li key={item} className="text-foreground font-mono text-xs break-all">
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader
              title="Immagini"
              description="Quante versioni tenere per progetto"
              actions={
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 5].map((n) => {
                    const active = (keepImages ?? data.retention.imagesPerProject) === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setKeepImages(n)}
                        aria-pressed={active}
                        className={cn(
                          "rounded-[var(--radius)] border px-2 py-1 text-xs transition-colors",
                          active
                            ? "selected text-foreground border-transparent"
                            : "border-border text-muted hover:bg-surface-hover"
                        )}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              }
            />
            {data.images.length === 0 ? (
              <p className="text-muted mt-3 text-sm">Nessuna immagine di RunPanel.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.images.map((image) => (
                  <li key={`${image.id}-${image.tag}`} className="flex items-center gap-2 text-xs">
                    <span className="text-foreground min-w-0 flex-1 truncate font-mono">
                      {image.repository}:{image.tag}
                    </span>
                    <span className="text-muted shrink-0 font-mono">{image.size}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Volumi" description="Contengono i dati dei servizi" />
            {data.volumes.length === 0 ? (
              <p className="text-muted mt-3 text-sm">Nessun volume di RunPanel.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.volumes.map((volume) => (
                  <li key={volume.name} className="text-foreground truncate font-mono text-xs">
                    {volume.name}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmOrphans}
        onOpenChange={setConfirmOrphans}
        destructive
        title="Rimuovere le risorse orfane?"
        confirmLabel="Rimuovi definitivamente"
        description={
          <>
            Verranno eliminati {orphanCount} elementi. Tra questi ci sono{" "}
            <strong>{data.orphans.volumes.length} volumi</strong>: contengono i dati di database
            il cui progetto o servizio non esiste più, e non sono recuperabili.
          </>
        }
        onConfirm={() => runSweep(true)}
      />
    </>
  );
}
