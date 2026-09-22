"use client";

import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Dropdown, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/LinkButton";
import { Panel } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { StatTile } from "@/components/ui/StatTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormDialog } from "@/components/ui/FormDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { HealthBanner } from "@/components/HealthBanner";
import { statusMeta, TONE_DOT } from "@/lib/status";
import { formatBytes, formatUptime } from "@/lib/format";
import { groupOverview, type FolderLike } from "@/lib/overview-groups";
import { cn } from "@/lib/utils";
import { serviceDisplayName } from "@/lib/service-name";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
  project_id: string | null;
  folder_id: string | null;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  app_name: string | null;
  source_type: string;
  source_url: string | null;
  runtime_type: string;
  status: string;
  port: number | null;
  deploy_count: number;
  folder_id: string | null;
  services: Service[];
}

interface Folder extends FolderLike {
  created_at: string;
  updated_at: string;
}

interface Metrics {
  cpu: { usage: number; cores: number };
  memory: { total: number; used: number };
  disk: { total: number; used: number; free: number };
  uptime: number;
}

/** Sentinel for the section that is not a folder. */
const LOOSE_SERVICES = "__loose-services";

/**
 * Which sections are closed, per browser.
 *
 * localStorage rather than the store: the server has one answer for every
 * device, and which folders someone keeps shut on a phone has nothing to do
 * with what they keep open on a desk. Every read and write is guarded because
 * a private window, a blocked origin or a thumbnail capture can each throw.
 */
const COLLAPSED_KEY = "runpanel.home.collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* nothing to do: the section still toggles, it just will not be remembered */
  }
}

const TYPE_ICONS: Record<string, string> = {
  postgresql: "solar:database-linear",
  mysql: "solar:database-linear",
  mongodb: "solar:database-linear",
  redis: "solar:bolt-linear",
};

async function patchJson(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true };
  const data = await res.json().catch(() => ({}));
  return { ok: false, error: typeof data.error === "string" ? data.error : undefined };
}

/**
 * The "⋯" on a card: where this card is filed, and where else it could go.
 *
 * One click, no dialog. The folders are few and named, so listing them is
 * quicker than a picker, and the current one is marked rather than hidden so
 * the menu also answers "which folder am I in" for a card seen out of context.
 */
function MoveMenu({
  label,
  folderId,
  folders,
  onMove,
}: {
  label: string;
  folderId: string | null;
  folders: FolderLike[];
  onMove: (folderId: string | null) => void;
}) {
  return (
    <Dropdown>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={`Azioni per ${label}`}
        className="text-muted hover:text-foreground -my-1 h-7 w-7 min-w-0 shrink-0"
      >
        <Icon icon="solar:menu-dots-bold" width={16} aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={`Sposta ${label}`}
          onAction={(key) => onMove(key === "root" ? null : String(key))}
        >
          <Dropdown.Section>
            <Dropdown.Item id="root" textValue="Nessuna cartella" isDisabled={folderId === null}>
              <Icon icon="solar:home-2-linear" width={14} aria-hidden />
              <span className="flex-1">Nessuna cartella</span>
              {folderId === null && <Icon icon="solar:check-read-linear" width={14} aria-hidden />}
            </Dropdown.Item>
            {folders.map((folder) => (
              <Dropdown.Item
                key={folder.id}
                id={folder.id}
                textValue={folder.name}
                isDisabled={folder.id === folderId}
              >
                <Icon icon="solar:folder-linear" width={14} aria-hidden />
                <span className="flex-1 truncate">{folder.name}</span>
                {folder.id === folderId && <Icon icon="solar:check-read-linear" width={14} aria-hidden />}
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Memoised so a 5-second metrics refresh does not re-render every card. */
const ProjectCard = memo(function ProjectCard({
  project,
  folders,
  onMove,
}: {
  project: Project;
  folders: FolderLike[];
  onMove: (projectId: string, folderId: string | null) => void;
}) {
  return (
    <Panel interactive padding="compact" className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <Link href={`/projects/${project.id}`} className="flex min-w-0 flex-1 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-foreground truncate text-sm font-medium">{project.name}</h3>
              <StatusBadge status={project.status} />
            </div>
            <p className="text-muted mt-1 truncate font-mono text-xs">
              {project.runtime_type}
              {project.port ? ` · :${project.port}` : ""}
              {project.deploy_count > 0 ? ` · ${project.deploy_count} deploy` : ""}
            </p>
          </div>
          <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted mt-0.5 shrink-0" aria-hidden />
        </Link>
        <MoveMenu
          label={project.name}
          folderId={project.folder_id}
          folders={folders}
          onMove={(folderId) => onMove(project.id, folderId)}
        />
      </div>

      {project.services.length > 0 && (
        <ul className="border-border flex flex-wrap gap-1.5 border-t pt-3">
          {project.services.map((service) => {
            const meta = statusMeta(service.status);
            return (
              <li key={service.id}>
                <Link
                  href={`/services/${service.id}`}
                  className="border-border bg-surface-secondary hover:bg-surface-hover flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors"
                >
                  <span className={cn("size-1.5 rounded-full", TONE_DOT[meta.tone])} aria-hidden />
                  <span className="text-foreground">{serviceDisplayName(service)}</span>
                  <span className="text-muted font-mono">{service.type}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
});

/**
 * A service that belongs to no project, which used to be invisible here: the
 * Overview listed services only as chips under the project they were linked
 * to, so a standalone Redis was a thing you had to remember existed.
 */
const ServiceCard = memo(function ServiceCard({
  service,
  folders,
  onMove,
}: {
  service: Service;
  folders: FolderLike[];
  onMove: (serviceId: string, folderId: string | null) => void;
}) {
  return (
    <Panel interactive padding="compact" className="flex items-center gap-2">
      <Link href={`/services/${service.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <Icon
          icon={TYPE_ICONS[service.type] ?? "solar:database-linear"}
          width={20}
          className="text-muted shrink-0"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-foreground truncate text-sm font-medium">{serviceDisplayName(service)}</h3>
            <StatusBadge status={service.status} />
          </div>
          <p className="text-muted mt-1 truncate font-mono text-xs">
            {service.type} {service.version} · :{service.port}
          </p>
        </div>
        <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted shrink-0" aria-hidden />
      </Link>
      <MoveMenu
        label={serviceDisplayName(service)}
        folderId={service.folder_id}
        folders={folders}
        onMove={(folderId) => onMove(service.id, folderId)}
      />
    </Panel>
  );
});

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function countLabel(projects: number, services: number): string {
  const parts: string[] = [];
  if (projects > 0) parts.push(projects === 1 ? "1 progetto" : `${projects} progetti`);
  if (services > 0) parts.push(services === 1 ? "1 servizio" : `${services} servizi`);
  return parts.length > 0 ? parts.join(" · ") : "Vuota";
}

type FolderDialog =
  | { kind: "create" }
  | { kind: "rename"; folder: Folder }
  | { kind: "delete"; folder: Folder }
  | null;

export default function HomePage() {
  // Every endpoint goes through the shared hook, so they stop polling when the
  // tab is hidden and never overlap requests.
  const poll5000 = usePollInterval(5000);

  const {
    data: projects,
    loading: projectsLoading,
    error,
    refresh: refreshProjects,
  } = useResource<Project[]>("/api/projects", { intervalMs: poll5000 });
  const { data: services, refresh: refreshServices } = useResource<Service[]>("/api/services", {
    intervalMs: poll5000,
  });
  const { data: folders, refresh: refreshFolders } = useResource<Folder[]>("/api/folders", {
    intervalMs: poll5000,
  });
  const { data: metrics } = useResource<Metrics>("/api/metrics", { intervalMs: poll5000 });

  // Read once, on the client, and only consulted when a section first mounts:
  // the sections are uncontrolled from then on, so a poll never snaps one shut.
  const [collapsed] = useState(readCollapsed);
  const rememberExpanded = useCallback(
    (id: string, expanded: boolean) => {
      if (expanded) collapsed.delete(id);
      else collapsed.add(id);
      writeCollapsed(collapsed);
    },
    [collapsed]
  );

  const [dialog, setDialog] = useState<FolderDialog>(null);
  const [nameValue, setNameValue] = useState("");

  const folderList = useMemo(() => (Array.isArray(folders) ? folders : []), [folders]);
  const grouped = useMemo(
    () =>
      groupOverview(
        folderList,
        Array.isArray(projects) ? projects : [],
        Array.isArray(services) ? services : []
      ),
    [folderList, projects, services]
  );

  const moveProject = useCallback(
    async (projectId: string, folderId: string | null) => {
      const result = await patchJson(`/api/projects/${projectId}`, { folderId });
      if (!result.ok) toast.error(result.error ?? "Spostamento non riuscito");
      await refreshProjects();
    },
    [refreshProjects]
  );

  const moveService = useCallback(
    async (serviceId: string, folderId: string | null) => {
      const result = await patchJson(`/api/services/${serviceId}`, { folderId });
      if (!result.ok) toast.error(result.error ?? "Spostamento non riuscito");
      await refreshServices();
    },
    [refreshServices]
  );

  function openDialog(next: Exclude<FolderDialog, null>) {
    setNameValue(next.kind === "rename" ? next.folder.name : "");
    setDialog(next);
  }

  async function submitFolderName() {
    const name = nameValue.trim();
    if (!dialog || !name) return;
    const isRename = dialog.kind === "rename";
    const res = await fetch(isRename ? `/api/folders/${dialog.folder.id}` : "/api/folders", {
      method: isRename ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? (isRename ? "Rinomina non riuscita" : "Creazione non riuscita"));
      return;
    }
    await refreshFolders();
  }

  async function deleteFolder() {
    if (dialog?.kind !== "delete") return;
    const res = await fetch(`/api/folders/${dialog.folder.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Eliminazione non riuscita");
      return;
    }
    // Its contents moved to the root, so the two lists that carry `folder_id`
    // are stale as well as the folder list itself.
    await Promise.all([refreshFolders(), refreshProjects(), refreshServices()]);
  }

  if (projectsLoading && !projects) return <PageSkeleton />;

  const memoryPercent = metrics?.memory.total
    ? (metrics.memory.used / metrics.memory.total) * 100
    : undefined;
  const diskPercent = metrics?.disk.total
    ? (metrics.disk.used / metrics.disk.total) * 100
    : undefined;

  const nothingAtAll =
    grouped.folders.length === 0 && grouped.rootProjects.length === 0 && grouped.looseServices.length === 0;
  const hasFolders = grouped.folders.length > 0;

  return (
    <>
      <PageHeader
        title="Panoramica"
        description="Progetti, servizi e stato della macchina"
        actions={
          <>
            <Button variant="secondary" onPress={() => openDialog({ kind: "create" })}>
              <Icon icon="solar:folder-with-files-linear" width={16} aria-hidden />
              Nuova cartella
            </Button>
            {/* A Link, not window.location: the latter is a full page reload —
                re-downloading and re-hydrating the whole app — where client-side
                navigation is instant. */}
            <LinkButton href="/projects/new" variant="secondary">
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Nuovo progetto
            </LinkButton>
          </>
        }
      />

      {/* Above the metrics on purpose: a number that is merely interesting
          should never sit above a problem that needs doing. */}
      <HealthBanner />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="CPU"
          value={metrics ? `${metrics.cpu.usage.toFixed(1)}%` : "—"}
          hint={metrics ? `${metrics.cpu.cores} core` : undefined}
          percent={metrics?.cpu.usage}
          icon="solar:cpu-linear"
        />
        <StatTile
          label="Memoria"
          value={formatBytes(metrics?.memory.used)}
          hint={metrics ? `di ${formatBytes(metrics.memory.total)}` : undefined}
          percent={memoryPercent}
          icon="solar:server-linear"
        />
        <StatTile
          label="Disco"
          value={formatBytes(metrics?.disk.used)}
          hint={metrics ? `di ${formatBytes(metrics.disk.total)}` : undefined}
          percent={diskPercent}
          icon="solar:ssd-square-linear"
        />
        <StatTile
          label="Uptime"
          value={formatUptime(metrics?.uptime)}
          icon="solar:clock-circle-linear"
        />
      </div>

      {error && (
        <Panel className="border-danger/30 mb-4">
          <p className="text-danger text-sm">
            Impossibile leggere i progetti: {error}. Il polling continua.
          </p>
        </Panel>
      )}

      {nothingAtAll ? (
        <Panel>
          <EmptyState
            icon="solar:widget-2-linear"
            title="Nessun progetto"
            description="Un progetto contiene un'app e i servizi di cui ha bisogno."
            action={
              <Link
                href="/projects/new"
                className="border-border bg-surface hover:bg-surface-hover text-foreground rounded-[var(--radius)] border px-4 py-2 text-sm transition-colors"
              >
                Crea il primo progetto
              </Link>
            }
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          {grouped.folders.map(({ folder, projects: filedProjects, services: filedServices }) => (
            <Section
              key={folder.id}
              title={
                <span className="flex items-center gap-2">
                  <Icon icon="solar:folder-linear" width={16} className="text-muted shrink-0" aria-hidden />
                  {folder.name}
                </span>
              }
              summary={countLabel(filedProjects.length, filedServices.length)}
              defaultExpanded={!collapsed.has(folder.id)}
              onExpandedChange={(expanded) => rememberExpanded(folder.id, expanded)}
              actions={
                <Dropdown>
                  <Button
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    aria-label={`Azioni per la cartella ${folder.name}`}
                    className="text-muted hover:text-foreground h-7 w-7 min-w-0"
                  >
                    <Icon icon="solar:menu-dots-bold" width={16} aria-hidden />
                  </Button>
                  <Dropdown.Popover placement="bottom end">
                    <Dropdown.Menu
                      aria-label={`Cartella ${folder.name}`}
                      onAction={(key) => {
                        const f = folderList.find((x) => x.id === folder.id);
                        if (!f) return;
                        if (key === "rename") openDialog({ kind: "rename", folder: f });
                        if (key === "delete") openDialog({ kind: "delete", folder: f });
                      }}
                    >
                      <Dropdown.Item id="rename" textValue="Rinomina">
                        <Icon icon="solar:pen-linear" width={14} aria-hidden />
                        Rinomina
                      </Dropdown.Item>
                      <Dropdown.Item id="delete" textValue="Elimina" className="text-danger">
                        <Icon icon="solar:trash-bin-minimalistic-linear" width={14} aria-hidden />
                        Elimina
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              }
            >
              {filedProjects.length === 0 && filedServices.length === 0 ? (
                <p className="text-muted text-sm">
                  Cartella vuota. Usa il menu ⋯ di un progetto o di un servizio per spostarlo qui.
                </p>
              ) : (
                <CardGrid>
                  {filedProjects.map((project) => (
                    <ProjectCard key={project.id} project={project} folders={folderList} onMove={moveProject} />
                  ))}
                  {filedServices.map((service) => (
                    <ServiceCard key={service.id} service={service} folders={folderList} onMove={moveService} />
                  ))}
                </CardGrid>
              )}
            </Section>
          ))}

          {grouped.rootProjects.length > 0 && (
            <div>
              {/* A heading only once there is something to tell these apart from. */}
              {hasFolders && (
                <h2 className="text-muted mb-2 px-1 text-xs font-medium tracking-wide uppercase">
                  Progetti senza cartella
                </h2>
              )}
              <CardGrid>
                {grouped.rootProjects.map((project) => (
                  <ProjectCard key={project.id} project={project} folders={folderList} onMove={moveProject} />
                ))}
              </CardGrid>
            </div>
          )}

          {grouped.looseServices.length > 0 && (
            <Section
              title={
                <span className="flex items-center gap-2">
                  <Icon icon="solar:database-linear" width={16} className="text-muted shrink-0" aria-hidden />
                  Servizi senza progetto
                </span>
              }
              summary={countLabel(0, grouped.looseServices.length)}
              defaultExpanded={!collapsed.has(LOOSE_SERVICES)}
              onExpandedChange={(expanded) => rememberExpanded(LOOSE_SERVICES, expanded)}
            >
              <CardGrid>
                {grouped.looseServices.map((service) => (
                  <ServiceCard key={service.id} service={service} folders={folderList} onMove={moveService} />
                ))}
              </CardGrid>
            </Section>
          )}
        </div>
      )}

      <FormDialog
        isOpen={dialog?.kind === "create" || dialog?.kind === "rename"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={dialog?.kind === "rename" ? "Rinomina cartella" : "Nuova cartella"}
        submitLabel={dialog?.kind === "rename" ? "Rinomina" : "Crea"}
        isSubmitDisabled={
          !nameValue.trim() || (dialog?.kind === "rename" && nameValue.trim() === dialog.folder.name)
        }
        onSubmit={submitFolderName}
      >
        <TextField value={nameValue} onChange={setNameValue} autoFocus>
          <Label>Nome</Label>
          <Input placeholder="Es. Clienti" maxLength={60} />
        </TextField>
      </FormDialog>

      <ConfirmDialog
        isOpen={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Eliminare la cartella?"
        description={
          dialog?.kind === "delete"
            ? `"${dialog.folder.name}" sparisce dalla Panoramica. I progetti e i servizi che contiene non vengono toccati: tornano fuori da ogni cartella.`
            : undefined
        }
        confirmLabel="Elimina"
        destructive
        onConfirm={deleteFolder}
      />
    </>
  );
}
