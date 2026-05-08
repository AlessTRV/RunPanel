"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";

interface ProcessInfo {
  running: boolean;
  pid?: number;
  memory?: number;
  cpu?: number;
  uptime?: number;
}

interface ServiceInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  port: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
}

interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  runtimeType: string;
  status: string;
  port: number | null;
  process: ProcessInfo | null;
  services: ServiceInfo[];
}

interface MonitorData {
  server: { cpu: number; memory: { total: number; used: number }; uptime: number };
  projects: ProjectInfo[];
}

function fmtMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb.toFixed(0)}M`;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const STATUS_DOT: Record<string, string> = {
  running: "text-emerald-400",
  stopped: "text-foreground-500",
  deploying: "text-amber-400",
  error: "text-red-400",
};

export default function MonitorPage() {
  const [data, setData] = useState<MonitorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    const poll = async () => {
      try {
        const res = await fetch("/api/monitor", { signal: controller.signal });
        if (res.ok) {
          const d = await res.json();
          setData(d);
          setLoading(false);
        }
      } catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);

  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (loading || !data) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  const memPercent = data.server.memory.total > 0 ? Math.round((data.server.memory.used / data.server.memory.total) * 100) : 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Monitor</h1>
        <p className="text-sm text-foreground-400">Real-time process and resource monitoring</p>
      </div>

      {/* Terminal-style monitor */}
      <div className="rounded-xl border border-white/[0.07] bg-black/50 backdrop-blur-2xl overflow-hidden font-mono text-xs">
        {/* Server totals header */}
        <div className="flex flex-wrap items-center gap-3 sm:gap-6 px-3 sm:px-4 py-3 border-b border-white/[0.07] bg-white/[0.03] text-foreground-400 text-[11px] sm:text-xs">
          <span className="font-bold text-foreground-300">SYSTEM</span>
          <span>CPU <span className="text-purple-400">{data.server.cpu}%</span></span>
          <span>RAM <span className="text-violet-400">{fmtMem(data.server.memory.used)}</span><span className="text-foreground-500">/{fmtMem(data.server.memory.total)}</span> <span className="text-violet-400">{memPercent}%</span></span>
          <span>UP <span className="text-emerald-400">{Math.floor(data.server.uptime / 3600)}h {Math.floor((data.server.uptime % 3600) / 60)}m</span></span>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[1fr_60px_50px] sm:grid-cols-[1fr_80px_70px_70px_70px_60px] gap-1 sm:gap-2 px-4 py-2 border-b border-white/[0.05] text-foreground-500 text-[10px] uppercase tracking-wider">
          <span>Name</span>
          <span className="text-right">Status</span>
          <span className="text-right">CPU</span>
          <span className="hidden sm:block text-right">Memory</span>
          <span className="hidden sm:block text-right">Uptime</span>
          <span className="hidden sm:block text-right">PID</span>
        </div>

        {/* Process rows */}
        <div className="divide-y divide-white/[0.03]">
          {data.projects.length === 0 ? (
            <div className="px-4 py-6 text-center text-foreground-500">No projects</div>
          ) : (
            data.projects.map((project) => {
              const isCollapsed = collapsed.has(project.id);

              return (
                <div key={project.id}>
                  {/* Project header row — name only, stats live on child rows */}
                  <div
                    className="flex items-center gap-2 px-4 py-2 hover:bg-white/[0.02] cursor-pointer transition-colors"
                    onClick={() => toggleCollapse(project.id)}
                  >
                    <Icon icon={isCollapsed ? "solar:alt-arrow-right-bold" : "solar:alt-arrow-down-bold"} width={10} className="text-foreground-500" />
                    <span className="text-foreground-200 font-semibold">{project.name}</span>
                  </div>

                  {/* Expanded: app process + services */}
                  {!isCollapsed && (
                    <>
                      {/* App process row */}
                      <div className="grid grid-cols-[1fr_60px_50px] sm:grid-cols-[1fr_80px_70px_70px_70px_60px] gap-1 sm:gap-2 px-4 py-1.5 pl-8 text-foreground-400 hover:bg-white/[0.02] transition-colors">
                        <span className="flex items-center gap-2">
                          <span className="text-foreground-500">{project.services.length > 0 ? "├─" : "└─"}</span>
                          <Icon icon="solar:server-square-bold" width={12} className="text-purple-400/70" />
                          <span>app</span>
                          <span className="text-foreground-500">({project.runtimeType})</span>
                          {project.port && <span className="text-foreground-500">:{project.port}</span>}
                        </span>
                        <span className={`text-right ${STATUS_DOT[project.status] || "text-foreground-500"}`}>
                          {project.status}
                        </span>
                        <span className="text-right">
                          {project.process?.cpu != null ? `${project.process.cpu}%` : "—"}
                        </span>
                        <span className="hidden sm:block text-right">
                          {project.process?.memory ? fmtMem(project.process.memory) : "—"}
                        </span>
                        <span className="hidden sm:block text-right">
                          {project.process?.uptime != null ? fmtUptime(project.process.uptime) : "—"}
                        </span>
                        <span className="hidden sm:block text-right text-foreground-500">
                          {project.process?.pid || "—"}
                        </span>
                      </div>

                      {/* Service rows */}
                      {project.services.map((svc, i) => {
                        const isLast = i === project.services.length - 1;
                        return (
                          <div key={svc.id} className="grid grid-cols-[1fr_60px_50px] sm:grid-cols-[1fr_80px_70px_70px_70px_60px] gap-1 sm:gap-2 px-4 py-1.5 pl-8 text-foreground-400 hover:bg-white/[0.02] transition-colors">
                            <span className="flex items-center gap-2">
                              <span className="text-foreground-500">{isLast ? "└─" : "├─"}</span>
                              <Icon icon={svc.type === "redis" ? "solar:database-bold" : svc.type === "mongodb" ? "solar:database-bold" : "solar:server-square-bold"} width={12} className="text-cyan-400/70" />
                              <span>{svc.name}</span>
                              <span className="text-foreground-500">({svc.type})</span>
                              <span className="text-foreground-500">:{svc.port}</span>
                            </span>
                            <span className={`text-right ${STATUS_DOT[svc.status] || "text-foreground-500"}`}>
                              {svc.status}
                            </span>
                            <span className="text-right">
                              {svc.cpu != null ? `${svc.cpu}%` : "—"}
                            </span>
                            <span className="hidden sm:block text-right">
                              {svc.memory ? fmtMem(svc.memory) : "—"}
                            </span>
                            <span className="hidden sm:block text-right">
                              {svc.uptime != null ? fmtUptime(svc.uptime) : "—"}
                            </span>
                            <span className="hidden sm:block text-right text-foreground-500">—</span>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-white/[0.07] bg-white/[0.02] text-foreground-500 text-[10px] flex items-center justify-between">
          <span>{data.projects.length} projects · {data.projects.reduce((n, p) => n + p.services.length, 0)} services</span>
          <span className="flex items-center gap-1">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            live · 2s
          </span>
        </div>
      </div>
    </div>
  );
}
