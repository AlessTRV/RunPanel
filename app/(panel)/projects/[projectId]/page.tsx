"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useProjectStream } from "@/lib/hooks/useProjectStream";
import { useResource } from "@/lib/hooks/useResource";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Panel } from "@/components/ui/Panel";
import { PageSkeleton } from "@/components/ui/Skeletons";
import type { LogLine } from "@/components/ui/LogViewer";
import { cn } from "@/lib/utils";

import { ProjectHeader } from "./_components/ProjectHeader";
import { ProjectStats } from "./_components/ProjectStats";
import { LogsTab } from "./_components/LogsTab";
import { DeploymentsTab } from "./_components/DeploymentsTab";
import { EnvTab } from "./_components/EnvTab";
import { TerminalTab } from "./_components/TerminalTab";
import { SettingsTab } from "./_components/SettingsTab";
import { FileManager } from "./_components/FileManager";
import type { Deployment, EnvVar, ProcessInfo, Project, TabId } from "./_components/types";

/**
 * Orchestrates the project view: it owns the single event stream and the shared
 * state, and hands each tab exactly what it needs.
 *
 * This file used to be 830 lines containing the header, five tabs, a file
 * manager, a deployment card and two modals, so every log line re-rendered all
 * of it.
 */

const MAX_LOG_LINES = 2000;
const TAB_IDS: TabId[] = ["logs", "deployments", "env", "terminal", "settings"];

/** Monotonic ids so log rows keep a stable key when the buffer is trimmed. */
let lineSeq = 0;
function toLine(text: string, stream: LogLine["stream"] = "stdout"): LogLine {
  return { id: ++lineSeq, text, stream };
}

function appendCapped(lines: LogLine[], next: LogLine): LogLine[] {
  const out = [...lines, next];
  return out.length > MAX_LOG_LINES ? out.slice(out.length - MAX_LOG_LINES) : out;
}

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  const tabParam = searchParams.get("tab") as TabId | null;
  const [activeTab, setActiveTab] = useState<TabId>(
    tabParam && TAB_IDS.includes(tabParam) ? tabParam : "logs"
  );

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);

  const [processLog, setProcessLog] = useState<LogLine[]>([]);
  const [deployLog, setDeployLog] = useState<LogLine[]>([]);

  const [termLines, setTermLines] = useState<string[]>([]);
  const [shellActive, setShellActive] = useState(false);

  const [renameOpen, setRenameOpen] = useState(tabParam === "settings");
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);

  const prevStatus = useRef<string | undefined>(undefined);

  const refreshProject = useCallback(
    (signal?: AbortSignal) =>
      fetch(`/api/projects/${projectId}`, { signal })
        .then((res) => {
          if (!res.ok) throw new Error("not found");
          return res.json();
        })
        .then((p: Project) => {
          setProject(p);
          setRenameValue(p.name);
          prevStatus.current = p.status;
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          router.push("/home");
        }),
    [projectId, router]
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshProject(controller.signal);
    return () => controller.abort();
  }, [refreshProject]);

  // One stream carries deploy progress, build output, process output and
  // terminal output. Everything used to be polled separately.
  const { connected } = useProjectStream(projectId, (event) => {
    switch (event.type) {
      case "deploy:log":
        setDeployLog((prev) => appendCapped(prev, toLine(event.line)));
        break;
      case "process:log":
        setProcessLog((prev) => appendCapped(prev, toLine(event.line, event.stream)));
        break;
      case "terminal:output":
        setTermLines((prev) => {
          const out = [...prev, event.text];
          return out.length > MAX_LOG_LINES ? out.slice(out.length - MAX_LOG_LINES) : out;
        });
        break;
      case "terminal:closed":
        setShellActive(false);
        break;
      case "deploy:status": {
        const previous = prevStatus.current;
        prevStatus.current = event.status;
        if (event.status === "building") setDeployLog([]);
        if (previous !== "running" && event.status === "running") toast.success("Deploy completato");
        if (event.status === "failed") toast.error(event.message ?? "Deploy fallito");
        void refreshProject();
        break;
      }
    }
  });

  // Process stats are a snapshot, not an event, so they still poll — but the
  // hook stops while the tab is hidden. Derived rather than copied into state:
  // mirroring fetched data into a useState is what turns one render into two.
  const { data: statusData } = useResource<{ process?: ProcessInfo | null }>(
    `/api/projects/${projectId}/status`,
    { intervalMs: 5000 }
  );
  const processInfo = statusData?.process ?? null;

  // Seed the process log from the tail; the stream carries it from there.
  useEffect(() => {
    if (activeTab !== "logs") return;
    const controller = new AbortController();
    fetch(`/api/projects/${projectId}/logs?source=process`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { logs: [] }))
      .then((data: { logs?: string[] }) => setProcessLog((data.logs ?? []).map((l) => toLine(l))))
      .catch(() => {});
    return () => controller.abort();
  }, [activeTab, projectId]);

  // Tab data is fetched by the shared hook, which owns its own loading flag —
  // so there is no effect here setting one synchronously. Passing `null` as the
  // url is how a tab that is not open stays idle.
  const { data: deploymentsData, loading: deploymentsLoading } = useResource<Deployment[]>(
    activeTab === "deployments" ? `/api/projects/${projectId}/logs` : null
  );
  const deployments = useMemo(
    () => (Array.isArray(deploymentsData) ? deploymentsData : []),
    [deploymentsData]
  );

  const { data: envData, loading: envLoading } = useResource<EnvVar[]>(
    activeTab === "env" ? `/api/projects/${projectId}/env?reveal=true` : null
  );

  async function handleDeploy(mode: "deploy" | "rebuild") {
    setDeploying(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Avvio fallito");
        return;
      }
      toast.success(data.status === "queued" ? "Messo in coda dopo il deploy in corso" : "Deploy avviato");
      if (data.status !== "queued") {
        setProject((p) => (p ? { ...p, status: "deploying" } : p));
      }
    } catch {
      toast.error("Avvio fallito");
    } finally {
      setDeploying(false);
    }
  }

  async function handleControl(action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(`/api/projects/${projectId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? `Azione "${action}" fallita`);
        return;
      }
      toast.success(`Azione "${action}" eseguita`);
      void refreshProject();
    } catch {
      toast.error(`Azione "${action}" fallita`);
    }
  }

  const tabs = useMemo(() => {
    if (!project) return [];
    return [
      { id: "logs" as TabId, label: "Log", icon: "solar:document-text-linear" },
      { id: "deployments" as TabId, label: "Deploy", icon: "solar:history-linear" },
      { id: "env" as TabId, label: "Variabili", icon: "solar:key-linear" },
      ...(project.runtime_type === "docker"
        ? [{ id: "terminal" as TabId, label: "Terminale", icon: "solar:monitor-linear" }]
        : []),
      { id: "settings" as TabId, label: "Impostazioni", icon: "solar:settings-linear" },
    ];
  }, [project]);

  if (loading || !project) return <PageSkeleton />;

  return (
    <div>
      <ProjectHeader
        project={project}
        busy={deploying}
        onDeploy={handleDeploy}
        onControl={handleControl}
        onOpenSettings={() => setRenameOpen(true)}
      />

      <ProjectStats info={processInfo} />

      <div
        role="tablist"
        aria-label="Sezioni del progetto"
        className="border-border mb-5 flex gap-1 overflow-x-auto border-b"
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
                active
                  ? "border-accent text-foreground font-medium"
                  : "text-muted hover:text-foreground border-transparent"
              )}
            >
              <Icon icon={tab.icon} width={15} aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Each tab is mounted only while selected. The file manager in
          particular used to render on every page load regardless. */}
      {activeTab === "logs" && (
        <div className="space-y-6">
          <LogsTab deployLog={deployLog} processLog={processLog} connected={connected} />
          <FileManager projectId={projectId} runtimeType={project.runtime_type} />
        </div>
      )}

      {activeTab === "deployments" && (
        <DeploymentsTab deployments={deployments} loading={deploymentsLoading} />
      )}

      {activeTab === "env" && (
        <EnvTab
          // Keyed on whether the data has arrived, so the editable copy is
          // seeded by React remounting the component rather than by an effect
          // that copies props into state.
          key={envData ? "loaded" : "loading"}
          projectId={projectId}
          runtimeType={project.runtime_type}
          initialVars={envData ?? []}
          loading={envLoading}
        />
      )}

      {activeTab === "terminal" && (
        <TerminalTab
          projectId={projectId}
          lines={termLines}
          active={shellActive}
          onActiveChange={setShellActive}
          onLocalEcho={(text) => setTermLines((prev) => [...prev, text])}
        />
      )}

      {activeTab === "settings" && (
        <SettingsTab project={project} onProjectChange={setProject} />
      )}

      {/* Rename + delete the project itself, as opposed to its app. */}
      {renameOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="bg-backdrop absolute inset-0"
            onClick={() => setRenameOpen(false)}
            aria-hidden
          />
          <Panel className="relative z-10 w-full max-w-md space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-foreground text-base font-medium">Progetto</h2>
              <button
                onClick={() => setRenameOpen(false)}
                className="text-muted hover:text-foreground"
                aria-label="Chiudi"
              >
                <Icon icon="solar:close-circle-linear" width={20} />
              </button>
            </div>

            <TextField value={renameValue} onChange={setRenameValue}>
              <Label>Nome</Label>
              <Input />
            </TextField>

            <Button
              variant="primary"
              className="w-full"
              onPress={async () => {
                const res = await fetch(`/api/projects/${projectId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: renameValue.trim() }),
                });
                if (res.ok) {
                  const updated = await res.json();
                  setProject((p) => (p ? { ...p, name: updated.name } : p));
                  toast.success("Progetto rinominato");
                  setRenameOpen(false);
                } else {
                  toast.error("Rinomina fallita");
                }
              }}
            >
              Salva
            </Button>

            <div className="border-border border-t pt-4">
              <p className="text-danger mb-1 text-sm font-medium">Zona pericolosa</p>
              <p className="text-muted mb-3 text-xs">
                Elimina il progetto, i suoi servizi, i volumi con i dati e le immagini costruite.
              </p>
              <Button variant="danger" className="w-full" onPress={() => setConfirmDeleteProject(true)}>
                <Icon icon="solar:trash-bin-trash-linear" width={18} aria-hidden />
                Elimina progetto e servizi
              </Button>
            </div>
          </Panel>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmDeleteProject}
        onOpenChange={setConfirmDeleteProject}
        destructive
        title="Eliminare il progetto?"
        confirmLabel="Elimina definitivamente"
        description="Verranno rimossi i processi, i container, le immagini e i volumi dei servizi collegati. I dati dei database non sono recuperabili."
        onConfirm={async () => {
          const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
          if (res.ok) {
            toast.success("Progetto eliminato");
            router.push("/home");
          } else {
            toast.error("Eliminazione fallita");
          }
        }}
      />
    </div>
  );
}
