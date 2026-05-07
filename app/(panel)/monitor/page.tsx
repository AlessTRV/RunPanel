"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";

interface ProcessInfo {
  running: boolean;
  pid?: number;
  memory?: number;
  cpu?: number;
}

interface ServiceInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  port: number;
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
        <div className="flex items-center gap-6 px-4 py-3 border-b border-white/[0.07] bg-white/[0.03] text-foreground-400">
          <span className="font-bold text-foreground-300">SYSTEM</span>
          <span>CPU <span className="text-purple-400">{data.server.cpu}%</span></span>
          <span>RAM <span className="text-violet-400">{fmtMem(data.server.memory.used)}</span><span className="text-foreground-500">/{fmtMem(data.server.memory.total)}</span> <span className="text-violet-400">{memPercent}%</span></span>
          <span>UP <span className="text-emerald-400">{Math.floor(data.server.uptime / 3600)}h {Math.floor((data.server.uptime % 3600) / 60)}m</span></span>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[1fr_80px_70px_80px_60px] gap-2 px-4 py-2 border-b border-white/[0.05] text-foreground-500 text-[10px] uppercase tracking-wider">
          <span>Name</span>
          <span className="text-right">Status</span>
          <span className="text-right">CPU</span>
          <span className="text-right">Memory</span>
          <span className="text-right">PID</span>
        </div>

        {/* Process rows */}
        <div className="divide-y divide-white/[0.03]">
          {data.projects.length === 0 ? (
            <div className="px-4 py-6 text-center text-foreground-500">No projects</div>
          ) : (
            data.projects.map((project) => {
              const isCollapsed = collapsed.has(project.id);
              const hasChildren = project.services.length > 0;

              return (
                <div key={project.id}>
                  {/* Project row (app) */}
                  <div
                    className="grid grid-cols-[1fr_80px_70px_80px_60px] gap-2 px-4 py-2 hover:bg-white/[0.02] cursor-pointer transition-colors"
                    onClick={() => hasChildren && toggleCollapse(project.id)}
                  >
                    <span className="flex items-center gap-2">
                      {hasChildren ? (
                        <Icon icon={isCollapsed ? "solar:alt-arrow-right-bold" : "solar:alt-arrow-down-bold"} width={10} className="text-foreground-500" />
                      ) : (
                        <span className="w-[10px]" />
                      )}
                      <Icon icon={`solar:${isCollapsed ? "alt-arrow-right" : "alt-arrow-down"}-bold`} width={0} className="hidden" />
                      <span className="text-foreground-300 font-medium">{project.name}</span>
                      <span className="text-foreground-500">({project.runtimeType})</span>
                    </span>
                    <span className={`text-right ${STATUS_DOT[project.status] || "text-foreground-500"}`}>
                      {project.status}
                    </span>
                    <span className="text-right text-foreground-300">
                      {project.process?.cpu != null ? `${project.process.cpu}%` : "—"}
                    </span>
                    <span className="text-right text-foreground-300">
                      {project.process?.memory ? fmtMem(project.process.memory) : "—"}
                    </span>
                    <span className="text-right text-foreground-500">
                      {project.process?.pid || "—"}
                    </span>
                  </div>

                  {/* Service children */}
                  {!isCollapsed && project.services.map((svc) => (
                    <div key={svc.id} className="grid grid-cols-[1fr_80px_70px_80px_60px] gap-2 px-4 py-1.5 pl-10 text-foreground-400 hover:bg-white/[0.02] transition-colors">
                      <span className="flex items-center gap-2">
                        <span className="text-foreground-500">└─</span>
                        <span>{svc.name}</span>
                        <span className="text-foreground-500">({svc.type})</span>
                      </span>
                      <span className={`text-right ${STATUS_DOT[svc.status] || "text-foreground-500"}`}>
                        {svc.status}
                      </span>
                      <span className="text-right">—</span>
                      <span className="text-right">—</span>
                      <span className="text-right text-foreground-500">:{svc.port}</span>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-white/[0.07] bg-white/[0.02] text-foreground-500 text-[10px] flex items-center justify-between">
          <span>{data.projects.length} projects</span>
          <span className="flex items-center gap-1">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            live · 2s
          </span>
        </div>
      </div>
    </div>
  );
}
