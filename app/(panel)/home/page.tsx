"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";

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
  source_type: string;
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

const serviceIcons: Record<string, string> = {
  postgresql: "solar:database-bold-duotone",
  mysql: "solar:database-bold-duotone",
  redis: "solar:bolt-bold-duotone",
  mongodb: "solar:database-bold-duotone",
};

const runtimeIcons: Record<string, string> = {
  node: "solar:code-bold-duotone",
  static: "solar:document-bold-duotone",
  docker: "solar:box-minimalistic-bold-duotone",
};

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/projects").then((r) => r.json()),
      fetch("/api/metrics").then((r) => r.json()),
    ])
      .then(([p, m]) => {
        setProjects(p);
        setMetrics(m);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  const memPercent = metrics ? Math.round((metrics.memory.used / metrics.memory.total) * 100) : 0;

  return (
    <div>
      {/* Server Stats */}
      <div className="flex items-start mb-8 divide-x divide-white/[0.07]">
        <div className="flex-1 px-4 first:pl-0">
          <div className="flex items-center gap-2 mb-1">
            <Icon icon="solar:cpu-bold-duotone" className="text-purple-400" width={16} />
            <p className="text-xs font-medium text-foreground-500">CPU</p>
          </div>
          <p className="text-2xl font-bold">{metrics?.cpu.usage ?? 0}%</p>
          <p className="text-xs text-foreground-500 mt-0.5">{metrics?.cpu.cores ?? 0} cores</p>
        </div>
        <div className="flex-1 px-4">
          <div className="flex items-center gap-2 mb-1">
            <Icon icon="solar:server-bold-duotone" className="text-violet-400" width={16} />
            <p className="text-xs font-medium text-foreground-500">Memory</p>
          </div>
          <p className="text-2xl font-bold">{memPercent}%</p>
          <p className="text-xs text-foreground-500 mt-0.5">{metrics ? `${formatBytes(metrics.memory.used)} / ${formatBytes(metrics.memory.total)}` : ""}</p>
        </div>
        <div className="flex-1 px-4">
          <div className="flex items-center gap-2 mb-1">
            <Icon icon="solar:clock-circle-bold-duotone" className="text-emerald-400" width={16} />
            <p className="text-xs font-medium text-foreground-500">Uptime</p>
          </div>
          <p className="text-2xl font-bold">{metrics ? formatUptime(metrics.uptime) : "—"}</p>
          <p className="text-xs text-foreground-500 mt-0.5">server</p>
        </div>
        <div className="flex-1 px-4 last:pr-0">
          <div className="flex items-center gap-2 mb-1">
            <Icon icon="solar:ssd-round-bold-duotone" className="text-amber-400" width={16} />
            <p className="text-xs font-medium text-foreground-500">Disk</p>
          </div>
          <p className="text-2xl font-bold">{metrics?.disk ? `${Math.round((metrics.disk.used / metrics.disk.total) * 100)}%` : "—"}</p>
          <p className="text-xs text-foreground-500 mt-0.5">{metrics?.disk ? `${formatBytes(metrics.disk.used)} / ${formatBytes(metrics.disk.total)}` : ""}</p>
        </div>
      </div>

      {/* Projects */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Projects</h2>
        <Link href="/projects/new">
          <Button variant="primary" size="sm">
            <Icon icon="solar:add-circle-bold-duotone" width={16} />
            New Project
          </Button>
        </Link>
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Icon icon="solar:box-bold-duotone" className="mb-3 text-foreground-300" width={40} />
            <p className="text-foreground-400">No projects yet</p>
            <p className="text-sm text-foreground-500">Create your first project to get started</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {projects.map((project) => (
            <div key={project.id}>
              {/* Project Header */}
              <div
                className="flex items-center justify-between mb-3 cursor-pointer group"
                onClick={() => router.push(`/projects/${project.id}`)}
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/15">
                    <Icon icon="solar:folder-bold-duotone" className="text-purple-400" width={20} />
                  </div>
                  <div>
                    <p className="font-semibold group-hover:text-purple-400 transition-colors">{project.name}</p>
                    <p className="text-xs text-foreground-500">{project.slug}</p>
                  </div>
                </div>
                <Icon icon="solar:arrow-right-linear" className="text-foreground-400 group-hover:text-purple-400 transition-colors" width={16} />
              </div>

              {/* Project Items Grid */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
                {/* App Card */}
                <Card
                  className="cursor-pointer transition-all hover:border-primary/30"
                  onClick={() => router.push(`/projects/${project.id}`)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/15">
                        <Icon icon={runtimeIcons[project.runtime_type] || runtimeIcons.node} className="text-purple-400" width={16} />
                      </div>
                      <StatusBadge status={project.status} />
                    </div>
                    <p className="font-medium text-sm">App</p>
                    <p className="text-xs text-foreground-500 mt-0.5">
                      {project.runtime_type}{project.port ? ` · :${project.port}` : ""}
                    </p>
                    <p className="text-xs text-foreground-400 mt-2">{project.deploy_count} deploys</p>
                  </CardContent>
                </Card>

                {/* Service Cards */}
                {project.services.map((service) => (
                  <Card
                    key={service.id}
                    className="cursor-pointer transition-all hover:border-secondary/30"
                    onClick={() => router.push(`/services/${service.id}`)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2.5 mb-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15">
                          <Icon icon={serviceIcons[service.type] || "solar:database-bold-duotone"} className="text-violet-400" width={16} />
                        </div>
                        <StatusBadge status={service.status} />
                      </div>
                      <p className="font-medium text-sm">{service.name}</p>
                      <p className="text-xs text-foreground-500 mt-0.5">
                        {service.type} {service.version}
                      </p>
                      <p className="text-xs text-foreground-400 mt-2">:{service.port}</p>
                    </CardContent>
                  </Card>
                ))}

                {/* Add Service Card */}
                <Card
                  className="cursor-pointer border-dashed transition-all hover:border-purple-400/20"
                  onClick={() => router.push(`/services/new?projectId=${project.id}`)}
                >
                  <CardContent className="flex flex-col items-center justify-center p-4 text-center min-h-[120px]">
                    <Icon icon="solar:add-circle-linear" className="text-foreground-400 mb-1" width={20} />
                    <p className="text-xs text-foreground-400">Add service</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
