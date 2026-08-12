"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Segmented, SegmentedMulti } from "@/components/ui/Segmented";
import { useResource } from "@/lib/hooks/useResource";
import { formatWhen } from "@/lib/format";
import type {
  BackupTarget,
  DestinationView,
  PolicyView,
  ProjectInclude,
  TargetCatalog,
} from "./types";

/**
 * Creating and editing a schedule.
 *
 * The selection model is three questions rather than a tree, because the tree
 * is where people give up: databases, the panel itself, projects — each of them
 * "everything", "some", or "none". The wire format underneath is still the full
 * selector list, so "everything" keeps meaning *whatever exists when the backup
 * runs* rather than a list frozen at the moment someone ticked a box.
 */

type Scope = "all" | "some" | "none";

const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "Solo su richiesta", cron: "" },
  { label: "Ogni ora", cron: "0 * * * *" },
  { label: "Ogni notte alle 03:00", cron: "0 3 * * *" },
  { label: "Ogni domenica alle 03:00", cron: "0 3 * * 0" },
];

const INCLUDE_LABELS: Record<ProjectInclude, string> = {
  config: "configurazione ed env",
  volumes: "volumi Docker",
  repo: "copia del repository",
};

interface Props {
  /** Absent when creating. */
  policy?: PolicyView;
}

interface Selection {
  databaseScope: Scope;
  services: Record<string, string[] | null>;
  panel: boolean;
  projectScope: Scope;
  projects: Record<string, boolean>;
  include: ProjectInclude[];
}

/**
 * Read the stored selectors back into the three questions the form asks.
 *
 * Derived at mount from the prop rather than synchronised in an effect: the
 * edit page only renders this once its policy has loaded, and it keys the form
 * on the id, so there is no later moment when the prop changes underneath.
 */
function initialSelection(policy?: PolicyView): Selection {
  const empty: Selection = {
    databaseScope: "all",
    services: {},
    panel: true,
    projectScope: "all",
    projects: {},
    include: ["config"],
  };
  if (!policy) return empty;

  const selection: Selection = {
    databaseScope: "none",
    services: {},
    panel: false,
    projectScope: "none",
    projects: {},
    include: [],
  };

  for (const target of policy.targets) {
    if (target.kind === "all-services") selection.databaseScope = "all";
    if (target.kind === "service") {
      if (selection.databaseScope !== "all") selection.databaseScope = "some";
      selection.services[target.id] = target.databases ?? null;
    }
    if (target.kind === "panel") selection.panel = true;
    if (target.kind === "all-projects") {
      selection.projectScope = "all";
      selection.include = target.include;
    }
    if (target.kind === "project") {
      if (selection.projectScope !== "all") selection.projectScope = "some";
      selection.projects[target.id] = true;
      if (selection.include.length === 0) selection.include = target.include;
    }
  }

  if (selection.include.length === 0) selection.include = ["config"];
  return selection;
}

/**
 * The three answers every scope question in this form takes.
 *
 * Defined once because "Tutti / Solo alcuni / Nessuno" appeared twice with the
 * same words and separate code, and a form that asks the same question twice
 * should visibly be asking the same question.
 */
const SCOPE_OPTIONS = [
  { value: "all" as Scope, label: "Tutti" },
  { value: "some" as Scope, label: "Solo alcuni" },
  { value: "none" as Scope, label: "Nessuno" },
];

export function PolicyForm({ policy }: Props) {
  const router = useRouter();
  const catalog = useResource<TargetCatalog>("/api/backups/targets");
  const destinations = useResource<{ destinations: DestinationView[] }>("/api/backups/destinations");

  const [initial] = useState(() => initialSelection(policy));

  const [name, setName] = useState(policy?.name ?? "Backup notturno");
  const [cron, setCron] = useState(policy?.cron ?? "0 3 * * *");
  const [timezone, setTimezone] = useState(policy?.timezone ?? "");
  const [chosenDestination, setChosenDestination] = useState(policy?.destinationId ?? "");

  const [databaseScope, setDatabaseScope] = useState<Scope>(initial.databaseScope);
  const [selectedServices, setSelectedServices] = useState(initial.services);
  const [includePanel, setIncludePanel] = useState(initial.panel);
  const [includeSecretKey, setIncludeSecretKey] = useState(policy?.includeSecretKey ?? false);
  const [projectScope, setProjectScope] = useState<Scope>(initial.projectScope);
  const [selectedProjects, setSelectedProjects] = useState(initial.projects);
  const [projectInclude, setProjectInclude] = useState<ProjectInclude[]>(initial.include);

  const [retentionCount, setRetentionCount] = useState(String(policy?.retentionCount ?? 7));
  const [retentionDays, setRetentionDays] = useState(
    policy?.retentionDays ? String(policy.retentionDays) : ""
  );
  const [retentionGb, setRetentionGb] = useState(
    policy?.retentionBytes ? String(Math.round(policy.retentionBytes / 1024 ** 3)) : ""
  );

  const [preview, setPreview] = useState<{ description: string; occurrences: string[] } | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);

  /**
   * What a closed section is set to. Without these, collapsing one would hide
   * the answer along with the controls, which is hiding information rather
   * than reducing it.
   */
  const scopeWord = (scope: Scope) =>
    scope === "all" ? "tutti" : scope === "some" ? "alcuni" : "nessuno";

  const contentSummary = [
    `database: ${scopeWord(databaseScope)}`,
    `progetti: ${scopeWord(projectScope)}`,
    includePanel ? "store del pannello" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const retentionSummary =
    [
      retentionCount ? `${retentionCount} archivi` : null,
      retentionDays ? `${retentionDays} giorni` : null,
      retentionGb ? `${retentionGb} GB` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "nessun limite";
  const [saving, setSaving] = useState(false);

  // Falls back to the first destination as soon as the list arrives, without an
  // effect writing state back into the component that just rendered.
  const destinationId = chosenDestination || destinations.data?.destinations[0]?.id || "";

  // The preview comes from the server's parser, not from a second guess written
  // in the browser — otherwise the form can accept what the scheduler rejects.
  useEffect(() => {
    // Nothing to preview, and nothing to clear: an empty expression simply
    // hides the preview at render time, so the effect never writes state
    // synchronously into the render that just scheduled it.
    if (!cron) return;

    const timer = setTimeout(() => {
      fetch("/api/backups/cron-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron, ...(timezone ? { timezone } : {}), count: 3 }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) {
            setPreview(null);
            setCronError(body.error ?? "Espressione non valida");
            return;
          }
          setCronError(null);
          setPreview(body);
        })
        .catch(() => setCronError("Impossibile verificare la pianificazione"));
    }, 350);

    return () => clearTimeout(timer);
  }, [cron, timezone]);

  const targets = useMemo<BackupTarget[]>(() => {
    const list: BackupTarget[] = [];

    if (databaseScope === "all") list.push({ kind: "all-services" });
    if (databaseScope === "some") {
      for (const [id, databases] of Object.entries(selectedServices)) {
        if (databases === undefined) continue;
        list.push(
          databases && databases.length > 0
            ? { kind: "service", id, databases }
            : { kind: "service", id }
        );
      }
    }

    if (includePanel) list.push({ kind: "panel" });

    if (projectScope === "all" && projectInclude.length > 0) {
      list.push({ kind: "all-projects", include: projectInclude });
    }
    if (projectScope === "some" && projectInclude.length > 0) {
      for (const [id, on] of Object.entries(selectedProjects)) {
        if (on) list.push({ kind: "project", id, include: projectInclude });
      }
    }

    return list;
  }, [
    databaseScope,
    selectedServices,
    includePanel,
    projectScope,
    selectedProjects,
    projectInclude,
  ]);

  const toggleService = useCallback((id: string) => {
    setSelectedServices((current) => {
      const next = { ...current };
      if (id in next) delete next[id];
      else next[id] = null;
      return next;
    });
  }, []);

  const toggleDatabase = useCallback((serviceId: string, database: string) => {
    setSelectedServices((current) => {
      const chosen = current[serviceId];
      if (chosen === undefined) return { ...current, [serviceId]: [database] };
      const list = chosen ?? [];
      const next = list.includes(database)
        ? list.filter((entry) => entry !== database)
        : [...list, database];
      return { ...current, [serviceId]: next.length > 0 ? next : null };
    });
  }, []);

  async function save() {
    if (!name.trim()) {
      toast.error("Dai un nome alla pianificazione");
      return;
    }
    if (targets.length === 0) {
      toast.error("Scegli almeno una cosa da salvare");
      return;
    }
    if (cron && cronError) {
      toast.error(cronError);
      return;
    }
    if (!destinationId) {
      toast.error("Scegli una destinazione");
      return;
    }

    const payload = {
      name: name.trim(),
      cron,
      timezone: timezone.trim() || null,
      destinationId,
      targets,
      retentionCount: retentionCount ? Number(retentionCount) : null,
      retentionDays: retentionDays ? Number(retentionDays) : null,
      retentionBytes: retentionGb ? Number(retentionGb) * 1024 ** 3 : null,
      includeSecretKey,
    };

    setSaving(true);
    try {
      const res = await fetch(
        policy ? `/api/backups/policies/${policy.id}` : "/api/backups/policies",
        {
          method: policy ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? body.details?.[0]?.message ?? MSG.saveFailed);
        return;
      }

      toast.success(policy ? "Pianificazione aggiornata" : "Pianificazione creata");
      router.push("/backups");
    } catch {
      toast.error(MSG.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const services = catalog.data?.services ?? [];
  const projects = catalog.data?.projects ?? [];

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader title="Nome e destinazione" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField value={name} onChange={setName}>
            <Label>Nome</Label>
            <Input placeholder="Backup notturno" />
          </TextField>

          <div>
            <label className="text-foreground mb-1.5 block text-sm" htmlFor="destination">
              Destinazione
            </label>
            <select
              id="destination"
              value={destinationId}
              onChange={(event) => setChosenDestination(event.target.value)}
              className="border-border bg-surface text-foreground h-9 w-full rounded-[var(--radius)] border px-2 text-sm"
            >
              {(destinations.data?.destinations ?? []).map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.name}
                </option>
              ))}
            </select>
            <FieldHint>Gli archivi restano su questa macchina, in data/backups.</FieldHint>
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Quando"
          description="Scegli un intervallo, oppure scrivi un'espressione cron a cinque campi."
        />

        <div className="mt-4">
          <Segmented
            label="Con che frequenza"
            value={cron}
            onChange={setCron}
            options={SCHEDULE_PRESETS.map((preset) => ({
              value: preset.cron,
              label: preset.label,
            }))}
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField value={cron} onChange={setCron}>
            <Label>Espressione cron</Label>
            <Input placeholder="0 3 * * *" />
          </TextField>

          <TextField value={timezone} onChange={setTimezone}>
            <Label>Fuso orario</Label>
            <Input placeholder="Europe/Rome" />
          </TextField>
        </div>

        <FieldHint>
          Vuota significa che parte solo quando lo chiedi tu. Il fuso vuoto usa quello del pannello.
        </FieldHint>

        {cron && cronError && (
          <Hint tone="warn" className="mt-3">
            {cronError}
          </Hint>
        )}

        {cron && preview && !cronError && (
          <Hint tone="info" className="mt-3" title={preview.description}>
            Prossime esecuzioni:{" "}
            {preview.occurrences.map((occurrence) => formatWhen(occurrence)).join(" · ")}
          </Hint>
        )}
      </Panel>

      {/*
        A schedule is four decisions — what to call it, when, what goes in, how
        much to keep — and the form should look like four. It looked like five
        equal panels with about fifteen pill controls between them, all open at
        once, so the shape of the decision was invisible.

        The two that have a defensible default are sections: they say what they
        are currently set to, and open only if that is not what you want.
      */}
      <Section title="Cosa salvare" summary={contentSummary} defaultExpanded={!policy}>

        {/* Databases */}
        <div className="mt-4">
          <p className="text-foreground text-sm font-medium">Database gestiti</p>
          <div className="mt-2">
            <Segmented
              label="Quali database salvare"
              value={databaseScope}
              onChange={setDatabaseScope}
              options={SCOPE_OPTIONS}
            />
          </div>

          {databaseScope === "all" && (
            <FieldHint>
              Include anche i servizi che creerai domani: la lista viene risolta all&apos;avvio di
              ogni backup, non adesso.
            </FieldHint>
          )}

          {databaseScope === "some" && (
            <div className="border-border mt-3 divide-y divide-[var(--color-border)] rounded-[var(--radius)] border">
              {services.length === 0 && (
                <p className="text-muted p-3 text-xs">Nessun servizio configurato.</p>
              )}
              {services.map((service) => {
                const chosen = service.id in selectedServices;
                const databases = selectedServices[service.id];
                return (
                  <div key={service.id} className="p-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={chosen}
                        onChange={() => toggleService(service.id)}
                      />
                      <span className="text-foreground">{service.name}</span>
                      <span className="text-muted text-xs">
                        {service.type} {service.version}
                      </span>
                    </label>

                    {chosen && service.databases.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2 pl-6">
                        {service.databases.map((database) => (
                          <label
                            key={database}
                            className="text-muted flex items-center gap-1.5 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked={Boolean(databases?.includes(database))}
                              onChange={() => toggleDatabase(service.id, database)}
                            />
                            {database}
                          </label>
                        ))}
                        <span className="text-muted text-meta">
                          {databases?.length
                            ? "solo i database spuntati"
                            : "nessuno spuntato: salva l'intero server, ruoli compresi"}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Panel store */}
        <div className="border-border mt-5 border-t pt-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includePanel}
              onChange={(event) => setIncludePanel(event.target.checked)}
            />
            <span className="text-foreground font-medium">Store del pannello</span>
          </label>
          <FieldHint>
            Progetti, servizi, variabili cifrate e impostazioni. Senza questo un ripristino rimette i
            dati ma non chi li possedeva.
          </FieldHint>

          {includePanel && (
            <div className="mt-3 pl-6">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeSecretKey}
                  onChange={(event) => setIncludeSecretKey(event.target.checked)}
                />
                <span className="text-foreground">Includi la chiave di cifratura</span>
              </label>
              {includeSecretKey && (
                <Hint tone="warn" className="mt-2">
                  Con la chiave dentro, l&apos;archivio si decifra da solo: è quello che serve per
                  ripartire su una macchina nuova, ed è anche quello che lo rende un dump completo di
                  credenziali. Trattalo come tratteresti <Code>data/.secret</Code>.
                </Hint>
              )}
            </div>
          )}
        </div>

        {/* Projects */}
        <div className="border-border mt-5 border-t pt-4">
          <p className="text-foreground text-sm font-medium">Progetti</p>
          <div className="mt-2">
            <Segmented
              label="Quali progetti salvare"
              value={projectScope}
              onChange={setProjectScope}
              options={SCOPE_OPTIONS}
            />
          </div>

          {projectScope !== "none" && (
            <>
              <div className="mt-3">
                <SegmentedMulti
                  label="Cosa salvare di ogni progetto"
                  values={projectInclude}
                  onChange={setProjectInclude}
                  options={(Object.keys(INCLUDE_LABELS) as ProjectInclude[]).map((include) => ({
                    value: include,
                    label: INCLUDE_LABELS[include],
                  }))}
                />
              </div>
              <FieldHint>
                Il repository è escluso di serie perché ce l&apos;ha già GitHub — tranne per i
                progetti caricati da ZIP, che non hanno nessun&apos;altra copia e vengono inclusi
                comunque.
              </FieldHint>
            </>
          )}

          {projectScope === "some" && (
            <div className="border-border mt-3 divide-y divide-[var(--color-border)] rounded-[var(--radius)] border">
              {projects.length === 0 && (
                <p className="text-muted p-3 text-xs">Nessun progetto configurato.</p>
              )}
              {projects.map((project) => (
                <label key={project.id} className="flex items-center gap-2 p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedProjects[project.id])}
                    onChange={(event) =>
                      setSelectedProjects((current) => ({
                        ...current,
                        [project.id]: event.target.checked,
                      }))
                    }
                  />
                  <span className="text-foreground">{project.slug}</span>
                  {project.volumes.length > 0 && (
                    <span className="text-muted text-xs">
                      {project.volumes.length} volum{project.volumes.length === 1 ? "e" : "i"}
                    </span>
                  )}
                  {project.sourceType === "upload" && (
                    <span className="text-muted text-meta">da ZIP</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        {targets.length === 0 && (
          <Hint tone="warn">
            Così com&apos;è, questa pianificazione non salverebbe niente.
          </Hint>
        )}
      </Section>

      <Section title="Quanto tenerne" summary={retentionSummary}>
        <FieldHint>
          I limiti si applicano insieme. L&apos;archivio riuscito più recente non viene mai
          cancellato, qualunque cosa dicano i numeri.
        </FieldHint>
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField value={retentionCount} onChange={setRetentionCount}>
            <Label>Quanti archivi</Label>
            <Input inputMode="numeric" placeholder="7" />
          </TextField>
          <TextField value={retentionDays} onChange={setRetentionDays}>
            <Label>Per quanti giorni</Label>
            <Input inputMode="numeric" placeholder="nessun limite" />
          </TextField>
          <TextField value={retentionGb} onChange={setRetentionGb}>
            <Label>Spazio massimo (GB)</Label>
            <Input inputMode="numeric" placeholder="nessun limite" />
          </TextField>
        </div>
      </Section>

      <div className="flex items-center gap-2">
        <Button onPress={save} isPending={saving}>
          <Icon icon="solar:diskette-linear" width={16} aria-hidden />
          {policy ? "Salva le modifiche" : "Crea la pianificazione"}
        </Button>
        <Button variant="secondary" onPress={() => router.push("/backups")}>
          Annulla
        </Button>
      </div>
    </div>
  );
}
