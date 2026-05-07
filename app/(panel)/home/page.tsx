"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner, TextField, Label, Input } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import Link from "next/link";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
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
  services: Service[];
}

interface Metrics {
  cpu: { usage: number; cores: number };
  memory: { total: number; used: number };
  disk: { total: number; used: number; free: number };
  uptime: number;
}

function formatBytes(bytes: number) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const statusColors: Record<string, string> = {
  running: "bg-emerald-400",
  stopped: "bg-foreground-400",
  deploying: "bg-amber-400",
  error: "bg-red-400",
};

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  // Initial load
  useEffect(() => {
    Promise.all([
      fetch("/api/projects").then((r) => r.json()),
      fetch("/api/metrics").then((r) => r.json()),
    ])
      .then(([p, m]) => { setProjects(p); setMetrics(m); })
      .finally(() => setLoading(false));
  }, []);

  // Poll metrics + project status every 5s
  useEffect(() => {
    const controller = new AbortController();
    const interval = setInterval(async () => {
      try {
        const [m, p] = await Promise.all([
          fetch("/api/metrics", { signal: controller.signal }).then((r) => r.ok ? r.json() : null),
          fetch("/api/projects", { signal: controller.signal }).then((r) => r.ok ? r.json() : null),
        ]);
        if (m) setMetrics(m);
        if (p) setProjects(p);
      } catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
    }, 5000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);

  // Project settings modal state
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editDeleting, setEditDeleting] = useState(false);

  function openProjectSettings(project: Project) {
    setEditProject(project);
    setEditName(project.name);
  }

  async function saveProjectName() {
    if (!editProject || !editName.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/projects/${editProject.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (res.ok) {
        toast.success("Project renamed");
        setProjects((prev) => prev.map((p) => p.id === editProject.id ? { ...p, name: editName.trim() } : p));
        setEditProject(null);
      } else { const d = await res.json(); toast.error(d.error || "Failed"); }
    } catch { toast.error("Failed"); }
    finally { setEditSaving(false); }
  }

  async function deleteProject() {
    if (!editProject) return;
    if (!confirm("Delete this project and ALL its services? This cannot be undone.")) return;
    setEditDeleting(true);
    try {
      const res = await fetch(`/api/projects/${editProject.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Project deleted");
        setProjects((prev) => prev.filter((p) => p.id !== editProject.id));
        setEditProject(null);
      } else { toast.error("Failed to delete"); }
    } catch { toast.error("Failed"); }
    finally { setEditDeleting(false); }
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  const memPercent = metrics && metrics.memory.total > 0 ? Math.round((metrics.memory.used / metrics.memory.total) * 100) : 0;
  const diskPercent = metrics?.disk && metrics.disk.total > 0 ? Math.round((metrics.disk.used / metrics.disk.total) * 100) : 0;

  const stats = [
    { label: "CPU", value: `${metrics?.cpu.usage ?? 0}%`, sub: `${metrics?.cpu.cores ?? 0} cores`, accent: "bg-orange-400" },
    { label: "Memory", value: `${memPercent}%`, sub: metrics ? `${formatBytes(metrics.memory.used)} / ${formatBytes(metrics.memory.total)}` : "", accent: "bg-blue-400" },
    { label: "Disk", value: `${diskPercent}%`, sub: metrics?.disk ? `${formatBytes(metrics.disk.used)} / ${formatBytes(metrics.disk.total)}` : "", accent: "bg-emerald-400" },
    { label: "Uptime", value: metrics ? formatUptime(metrics.uptime) : "—", sub: "server", accent: "bg-purple-400" },
  ];

  return (
    <div>
      {/* ── Metrics ── */}
      <div className="grid grid-cols-1 gap-4 mb-12 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-[14px] bg-white/[0.04] p-4 sm:p-5 flex flex-col justify-between min-h-[100px] sm:min-h-[120px]">
            <p className="text-[13px] font-medium text-foreground-500">{s.label}</p>
            <div>
              <p className="text-[26px] sm:text-[34px] font-bold leading-none tracking-tight">{s.value}</p>
              <p className="text-[12px] text-foreground-500 mt-1">{s.sub}</p>
            </div>
            <div className={`h-[3px] w-full rounded-full ${s.accent} opacity-40 mt-3`} />
          </div>
        ))}
      </div>

      {/* ── Projects Header ── */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-[24px] sm:text-[32px] font-bold tracking-tight">Projects</h1>
        <Link href="/projects/new">
          <Button variant="outline" size="sm" className="rounded-[10px] px-4">
            <Icon icon="solar:add-circle-linear" width={16} />
            New
          </Button>
        </Link>
      </div>

      {/* ── Project Groups ── */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-center">
          <Icon icon="solar:box-bold-duotone" className="mb-3 text-foreground-300" width={40} />
          <p className="text-foreground-400">No projects yet</p>
          <p className="text-sm text-foreground-500 mb-4">Create your first project to get started</p>
          <Link href="/projects/new">
            <Button variant="primary" size="sm">New Project</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-10">
          {projects.map((project) => (
            <div key={project.id}>
              {/* Project Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-[20px] font-bold">{project.name}</h2>
                  <Button variant="ghost" size="sm" onPress={() => openProjectSettings(project)} aria-label="Project settings">
                    <Icon icon="solar:settings-bold-duotone" width={16} />
                  </Button>
                </div>
                <Button variant="ghost" size="sm" onPress={() => router.push(`/services/new?projectId=${project.id}`)}>
                  <Icon icon="solar:add-circle-linear" width={16} />
                  Add
                </Button>
              </div>

              {/* Divider */}
              <div className="border-b border-white/[0.06] my-5" />

              {/* Service Cards Grid */}
              <div className="flex flex-wrap gap-4">
                {/* App card — only if configured (has source_url, app_name, or been deployed) */}
                {(project.source_url || project.app_name || project.status !== "stopped" || project.deploy_count > 0) && (
                  <div
                    className="flex items-center justify-between w-full sm:w-[260px] rounded-xl bg-white/[0.05] px-4 py-4 cursor-pointer hover:bg-white/[0.07] transition-colors"
                    onClick={() => router.push(`/projects/${project.id}`)}
                  >
                    <div>
                      <p className="text-[14px] font-semibold">{project.app_name || project.slug}</p>
                      <p className="text-[13px] text-foreground-500 mt-0.5">app · {project.runtime_type}{project.port ? ` · :${project.port}` : ""}</p>
                    </div>
                    <div className={`h-[10px] w-[10px] rounded-full ${statusColors[project.status] || "bg-foreground-400"}`} />
                  </div>
                )}

                {/* Service cards */}
                {project.services.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between w-full sm:w-[260px] rounded-xl bg-white/[0.05] px-4 py-4 cursor-pointer hover:bg-white/[0.07] transition-colors"
                    onClick={() => router.push(`/services/${service.id}`)}
                  >
                    <div>
                      <p className="text-[14px] font-semibold">{service.name}</p>
                      <p className="text-[13px] text-foreground-500 mt-0.5">{service.type} {service.version}</p>
                    </div>
                    <div className={`h-[10px] w-[10px] rounded-full ${statusColors[service.status] || "bg-foreground-400"}`} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Project Settings Modal */}
      {editProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setEditProject(null)} />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/[0.07] bg-black/80 backdrop-blur-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold">Project Settings</h2>
              <button onClick={() => setEditProject(null)} className="text-foreground-400 hover:text-foreground transition-colors">
                <Icon icon="solar:close-circle-bold-duotone" width={22} />
              </button>
            </div>

            <div className="space-y-4">
              <TextField value={editName} onChange={setEditName}>
                <Label>Project Name</Label>
                <Input onKeyDown={(e) => e.key === "Enter" && saveProjectName()} />
              </TextField>
              <Button variant="primary" className="w-full" isDisabled={editSaving} onPress={saveProjectName}>
                {editSaving ? <Spinner /> : "Save"}
              </Button>
            </div>

            <div className="mt-8 pt-6 border-t border-white/[0.07]">
              <p className="text-sm font-semibold text-danger mb-2">Danger Zone</p>
              <p className="text-xs text-foreground-500 mb-4">This will stop all processes, remove all services, and delete all project data.</p>
              <Button variant="danger" className="w-full" isDisabled={editDeleting} onPress={deleteProject}>
                {editDeleting ? <Spinner /> : <><Icon icon="solar:trash-bin-trash-bold-duotone" width={18} />Delete Project</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
