"use client";

import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Code, Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { useResource } from "@/lib/hooks/useResource";
import { cn } from "@/lib/utils";
import { formatWhen } from "../backups/_components/format";
import type { AutostartData, AutostartEntry } from "./_components/types";

const METHOD_LABELS: Record<string, string> = {
  systemd: "systemd",
  cron: "cron @reboot",
  container: "Docker (il pannello è in un container)",
  manual: "manuale",
};

export default function AutostartPage() {
  const { data, loading, refresh } = useResource<AutostartData>("/api/autostart", {
    intervalMs: 15_000,
  });

  const [edits, setEdits] = useState<Record<string, Partial<AutostartEntry>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ commands: string[]; reason: string } | null>(null);

  const entries = useMemo(() => {
    return (data?.entries ?? []).map((entry) => ({ ...entry, ...edits[entry.id] }));
  }, [data?.entries, edits]);

  const services = entries.filter((entry) => entry.kind === "service");
  const projects = entries.filter((entry) => entry.kind === "project");
  const mismatched = entries.filter((entry) => entry.policyMatches === false);
  const dirty = Object.keys(edits).length > 0;

  function edit(id: string, patch: Partial<AutostartEntry>) {
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  async function save() {
    setBusy("save");
    try {
      const res = await fetch("/api/autostart", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: Object.entries(edits).map(([id, patch]) => {
            const entry = entries.find((candidate) => candidate.id === id);
            return {
              kind: entry?.kind ?? "project",
              id,
              autostart: patch.autostart ?? entry?.autostart ?? false,
              order: patch.order ?? entry?.order,
              delaySeconds: patch.delaySeconds ?? entry?.delaySeconds,
              waitHealthy: patch.waitHealthy ?? entry?.waitHealthy,
            };
          }),
        }),
      });
      if (!res.ok) {
        toast.error("Salvataggio non riuscito");
        return;
      }
      toast.success("Preferenze di avvio salvate");
      setEdits({});
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function host(action: "install" | "uninstall" | "preview", method?: "systemd" | "cron") {
    setBusy(action);
    try {
      const res = await fetch("/api/autostart/host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(method ? { method } : {}) }),
      });
      const body = await res.json();

      if (action === "preview") {
        setPlan({ commands: body.plan?.commands ?? [], reason: body.plan?.reason ?? "" });
        return;
      }

      if (body.ok || body.installed) {
        toast.success(body.message ?? "Fatto");
        setPlan(null);
      } else {
        toast.error(body.message ?? body.error ?? "Operazione non riuscita");
        // Not being root is the ordinary case, so show what to paste instead of
        // just refusing.
        if (body.plan?.commands?.length) {
          setPlan({ commands: body.plan.commands, reason: body.plan.reason });
        }
      }
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function reconcile(dryRun: boolean) {
    setBusy(dryRun ? "dry" : "run");
    try {
      const res = await fetch("/api/autostart/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? "Operazione non riuscita");
        return;
      }
      toast.success(
        dryRun
          ? `Simulazione: ${body.entries.filter((e: { action: string }) => e.action === "would-start").length} da avviare`
          : `${body.started} avviati, ${body.failed} falliti`
      );
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function fix(body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const res = await fetch("/api/autostart/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (result.ok) toast.success(result.message ?? "Fatto");
      else toast.error(result.error ?? result.message ?? "Non riuscito");
      refresh();
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Avvio automatico" />
        <div className="space-y-4">
          <SkeletonBlock className="h-56" />
          <SkeletonBlock className="h-64" />
        </div>
      </>
    );
  }

  const probe = data?.probe;

  return (
    <>
      <PageHeader
        title="Avvio automatico"
        description="Che cosa succede dopo un riavvio della macchina: se torna su il pannello, e che cosa riporta su lui."
        actions={
          dirty ? (
            <Button size="sm" onPress={save} isPending={busy === "save"}>
              <Icon icon="solar:diskette-linear" width={16} aria-hidden />
              Salva le modifiche
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title="Avvio del pannello"
            description={probe?.recommendedReason}
            actions={
              probe?.recommended === "systemd" || probe?.recommended === "cron" ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => host("preview")}
                    isPending={busy === "preview"}
                  >
                    Mostra i comandi
                  </Button>
                  {probe.systemd.enabled || data?.stored ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => host("uninstall")}
                      isPending={busy === "uninstall"}
                    >
                      Disattiva
                    </Button>
                  ) : (
                    <Button size="sm" onPress={() => host("install")} isPending={busy === "install"}>
                      <Icon icon="solar:power-linear" width={16} aria-hidden />
                      Attiva l&apos;avvio al boot
                    </Button>
                  )}
                </div>
              ) : undefined
            }
          />

          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <Row
              label="Metodo"
              value={METHOD_LABELS[probe?.recommended ?? "manual"]}
              tone="neutral"
            />
            <Row
              label="Unit systemd"
              value={
                !probe?.systemd.available
                  ? "systemd non disponibile"
                  : probe.systemd.enabled
                    ? probe.systemd.active
                      ? "abilitata e attiva"
                      : "abilitata, partirà al prossimo riavvio"
                    : probe.systemd.installed
                      ? "installata ma non abilitata"
                      : "non installata"
              }
              tone={probe?.systemd.enabled ? "ok" : "warn"}
            />
            <Row
              label="Riga @reboot nel crontab"
              value={
                !probe?.cron.available
                  ? "crontab non disponibile"
                  : probe.cron.installed
                    ? "presente"
                    : "assente"
              }
              tone={probe?.cron.installed ? "ok" : "neutral"}
            />
            <Row
              label="Docker al boot"
              value={
                probe?.docker.enabledAtBoot === null
                  ? "non verificabile su questa piattaforma"
                  : probe?.docker.enabledAtBoot
                    ? "abilitato"
                    : "NON abilitato"
              }
              tone={probe?.docker.enabledAtBoot === false ? "warn" : "ok"}
              action={
                probe?.docker.enabledAtBoot === false ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => fix({ fix: "docker-enable" }, "docker")}
                    isPending={busy === "docker"}
                  >
                    Abilita
                  </Button>
                ) : undefined
              }
            />
            <Row
              label="PM2 resurrect"
              value={
                !probe?.pm2.available
                  ? "pm2 non installato"
                  : probe.pm2.dumpSaved
                    ? "lista salvata"
                    : "nessuna lista salvata"
              }
              tone={probe?.pm2.available && !probe.pm2.dumpSaved ? "warn" : "neutral"}
              action={
                probe?.pm2.available && !probe.pm2.dumpSaved ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => fix({ fix: "pm2-save" }, "pm2")}
                    isPending={busy === "pm2"}
                  >
                    pm2 save
                  </Button>
                ) : undefined
              }
            />
            <Row
              label="Utente"
              value={`${probe?.environment.user}${probe?.environment.root ? " (root)" : ""}`}
              tone="neutral"
            />
          </dl>

          {probe?.environment.containerised && (
            <Hint tone="info" className="mt-4" title="Il pannello gira dentro un container">
              Qui non serve una unit systemd: a riportarlo su è Docker. Assicurati che il container
              abbia <Code>--restart unless-stopped</Code>
              {probe.selfContainer.restartPolicy
                ? ` — adesso ha "${probe.selfContainer.restartPolicy}".`
                : "."}
            </Hint>
          )}

          {probe?.pm2.available && !probe.pm2.dumpSaved && (
            <Hint tone="warn" className="mt-4" title="Le app PM2 non tornerebbero su">
              PM2 fa girare i progetti con runtime nativo, e riporta su solo quello che è stato
              salvato con <Code>pm2 save</Code>. Senza, dopo un riavvio il pannello torna e le app no.
            </Hint>
          )}

          {plan && (
            <div className="mt-4">
              <p className="text-muted mb-2 text-xs">{plan.reason}</p>
              <CommandBlock commands={plan.commands} />
            </div>
          )}
        </Panel>

        {mismatched.length > 0 && (
          <Hint tone="warn" title="La restart policy non corrisponde">
            {mismatched.length} container{mismatched.length === 1 ? "" : "s"} tornerebbe su in modo
            diverso da quello che dice il pannello. Docker riavvia in base alla propria policy,
            quindi finché non le allinei l&apos;interruttore qui sopra non dice la verità.
            <ul className="mt-2 space-y-1">
              {mismatched.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 text-xs">
                  <span className="text-foreground">{entry.name}</span>
                  <span className="text-muted">
                    policy attuale &ldquo;{entry.restartPolicy || "nessuna"}&rdquo;, attesa &ldquo;
                    {entry.autostart ? "unless-stopped" : "no"}&rdquo;
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      fix(
                        { fix: "restart-policy", target: { kind: entry.kind, id: entry.id } },
                        entry.id
                      )
                    }
                    isPending={busy === entry.id}
                  >
                    Correggi
                  </Button>
                </li>
              ))}
            </ul>
          </Hint>
        )}

        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Cosa avviare"
              description="I servizi partono prima dei progetti. L'ordine più basso va per primo."
            />
          </div>

          {entries.length === 0 ? (
            <EmptyState
              icon="solar:play-circle-linear"
              title="Niente da avviare"
              description="Appena crei un progetto o un servizio, compare qui."
            />
          ) : (
            <>
              <Group title="Servizi" entries={services} onEdit={edit} />
              <Group title="Progetti" entries={projects} onEdit={edit} />
            </>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Ultimo avvio"
            description={
              data?.reconcilerEnabled
                ? "Che cosa ha fatto il pannello l'ultima volta che è ripartito."
                : "La riconciliazione è disattivata in questa istanza (RUNPANEL_DISABLE_SCHEDULERS)."
            }
            actions={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => reconcile(true)}
                  isPending={busy === "dry"}
                >
                  Simula
                </Button>
                <Button size="sm" variant="secondary" onPress={() => reconcile(false)} isPending={busy === "run"}>
                  Esegui ora
                </Button>
              </div>
            }
          />

          {!data?.report ? (
            <p className="text-muted mt-4 text-sm">
              Nessun avvio registrato: il riepilogo compare dopo il primo riavvio, oppure premendo
              Esegui ora.
            </p>
          ) : (
            <div className="mt-4">
              <p className="text-muted text-xs">
                {formatWhen(data.report.startedAt)} · {data.report.started} avviati ·{" "}
                {data.report.failed} falliti
                {data.report.dryRun ? " · simulazione" : ""}
              </p>
              <ul className="divide-border mt-2 divide-y">
                {data.report.entries.map((entry) => (
                  <li key={`${entry.kind}-${entry.id}`} className="flex items-center gap-3 py-2">
                    <span
                      className={cn(
                        "text-xs",
                        entry.action === "failed" ? "text-danger" : "text-muted"
                      )}
                    >
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </span>
                    <span className="text-foreground truncate text-sm">{entry.name}</span>
                    <span className="text-muted truncate text-xs">{entry.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

const ACTION_LABELS: Record<string, string> = {
  started: "avviato",
  "already-running": "già su",
  "would-start": "da avviare",
  skipped: "saltato",
  failed: "fallito",
};

function Row({
  label,
  value,
  tone,
  action,
}: {
  label: string;
  value: React.ReactNode;
  tone: "ok" | "warn" | "neutral";
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <dt className="text-muted text-xs">{label}</dt>
        <dd
          className={cn(
            "mt-0.5 truncate text-sm",
            tone === "warn" ? "text-warning" : tone === "ok" ? "text-foreground" : "text-foreground"
          )}
        >
          {value}
        </dd>
      </div>
      {action}
    </div>
  );
}

function Group({
  title,
  entries,
  onEdit,
}: {
  title: string;
  entries: AutostartEntry[];
  onEdit: (id: string, patch: Partial<AutostartEntry>) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <div>
      <p className="text-muted border-border border-t px-4 py-2 text-xs sm:px-5">{title}</p>
      <ul className="divide-border divide-y">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
            <label className="flex min-w-0 flex-1 items-center gap-3">
              <input
                type="checkbox"
                checked={entry.autostart}
                onChange={(event) => onEdit(entry.id, { autostart: event.target.checked })}
              />
              <span className="min-w-0">
                <span className="text-foreground block truncate text-sm">{entry.name}</span>
                <span className="text-muted text-xs">{entry.subtitle}</span>
              </span>
            </label>

            <StatusBadge status={entry.status} variant="dot" />

            <div className="flex items-center gap-3">
              <label className="text-muted flex items-center gap-1 text-xs">
                ordine
                <input
                  type="number"
                  value={entry.order}
                  min={0}
                  max={9999}
                  onChange={(event) => onEdit(entry.id, { order: Number(event.target.value) })}
                  className="border-border bg-surface text-foreground h-7 w-16 rounded-[var(--radius)] border px-1.5 text-xs"
                />
              </label>
              <label className="text-muted flex items-center gap-1 text-xs">
                attesa
                <input
                  type="number"
                  value={entry.delaySeconds}
                  min={0}
                  max={600}
                  onChange={(event) =>
                    onEdit(entry.id, { delaySeconds: Number(event.target.value) })
                  }
                  className="border-border bg-surface text-foreground h-7 w-16 rounded-[var(--radius)] border px-1.5 text-xs"
                />
                s
              </label>
              <label className="text-muted flex items-center gap-1 text-xs" title="Aspetta che risponda prima di passare al successivo">
                <input
                  type="checkbox"
                  checked={entry.waitHealthy}
                  onChange={(event) => onEdit(entry.id, { waitHealthy: event.target.checked })}
                />
                pronto
              </label>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CommandBlock({ commands }: { commands: string[] }) {
  const text = commands.join("\n\n");
  return (
    <div className="border-border bg-surface-secondary relative rounded-[var(--radius)] border">
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-2 right-2"
        onPress={() => {
          void navigator.clipboard.writeText(text);
          toast.success("Comandi copiati");
        }}
      >
        <Icon icon="solar:copy-linear" width={15} aria-hidden />
        Copia
      </Button>
      <pre className="text-muted overflow-x-auto p-3 pr-24 text-[11px] leading-relaxed whitespace-pre">
        {text}
      </pre>
    </div>
  );
}
