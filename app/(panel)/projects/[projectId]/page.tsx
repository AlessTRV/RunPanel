"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Spinner,
  Tabs,
  TabsRoot,
  TabList,
  Tab,
  TabPanel,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/StatusBadge";

interface Project {
  id: string;
  name: string;
  slug: string;
  source_type: string;
  source_url: string | null;
  source_branch: string;
  runtime_type: string;
  status: string;
  port: number | null;
  auto_deploy: number;
  deploy_count: number;
  last_deploy_at: string | null;
  created_at: string;
}

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);

  const projectId = params.projectId as string;

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then(setProject)
      .catch(() => router.push("/projects"))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  // Poll for status updates — always poll to keep status truthful
  useEffect(() => {
    if (!project) return;
    const prevStatus = project.status;
    const interval = setInterval(() => {
      fetch(`/api/projects/${projectId}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data) return;
          setProject(data);
          if (prevStatus === "deploying" && data.status === "running") toast.success("Deploy completed");
          if (prevStatus === "deploying" && data.status === "error") toast.error("Deploy failed");
        });
    }, 3000);
    return () => clearInterval(interval);
  }, [project?.status, projectId]);

  async function handleDeploy(mode: "deploy" | "rebuild" = "deploy") {
    if (mode === "rebuild" && !confirm("Re-Build will delete node_modules, .next and all caches, then reinstall and rebuild from scratch. Continue?")) {
      return;
    }
    setDeploying(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(mode === "rebuild" ? "Re-Build started" : "Deployment started");
        setProject((p) => p ? { ...p, status: "deploying" } : p);
      } else {
        toast.error(data.error || "Deploy failed");
      }
    } catch {
      toast.error("Deploy failed");
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
      if (res.ok) {
        toast.success(`Process ${action} triggered`);
        // Refresh project status immediately
        const updated = await fetch(`/api/projects/${projectId}`).then((r) => r.json());
        setProject(updated);
      } else {
        const data = await res.json();
        toast.error(data.error || `Failed to ${action}`);
      }
    } catch {
      toast.error(`Failed to ${action}`);
    }
  }

  if (loading || !project) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Icon icon="solar:box-bold-duotone" className="text-primary" width={28} />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{project.name}</h1>
              <StatusBadge status={project.status} />
            </div>
            <p className="text-sm text-foreground-400">
              {project.source_type === "github" ? project.source_url : "Uploaded ZIP"}
              {" · "}{project.runtime_type} · :{project.port || "auto"}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {(project.status === "running" || project.status === "error") && (
            <>
              <Button variant="outline" size="sm" onPress={() => handleControl("restart")}>
                <Icon icon="solar:refresh-bold-duotone" width={16} />
                Restart
              </Button>
              <Button variant="danger" size="sm" onPress={() => handleControl("stop")}>
                <Icon icon="solar:stop-bold-duotone" width={16} />
                Stop
              </Button>
            </>
          )}
          {(project.status === "stopped" || project.status === "error") && (
            <Button variant="secondary" size="sm" onPress={() => handleControl("start")}>
              <Icon icon="solar:play-bold-duotone" width={16} />
              Start
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            isDisabled={deploying || project.status === "deploying"}
            onPress={() => handleDeploy("rebuild")}
          >
            <Icon icon="solar:refresh-circle-bold-duotone" width={16} />
            Re-Build
          </Button>
          <Button
            variant="primary"
            isDisabled={deploying || project.status === "deploying"}
            onPress={() => handleDeploy("deploy")}
          >
            {deploying ? <Spinner /> : <Icon icon="solar:upload-bold-duotone" width={18} />}
            Deploy
          </Button>
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Icon icon="solar:upload-bold-duotone" width={20} className="text-foreground-400" />
            <div>
              <p className="text-sm text-foreground-400">Deployments</p>
              <p className="text-lg font-semibold">{project.deploy_count}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Icon icon="solar:clock-circle-bold-duotone" width={20} className="text-foreground-400" />
            <div>
              <p className="text-sm text-foreground-400">Last Deploy</p>
              <p className="text-lg font-semibold">
                {project.last_deploy_at
                  ? new Date(project.last_deploy_at).toLocaleDateString()
                  : "Never"}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Icon icon="solar:code-bold-duotone" width={20} className="text-foreground-400" />
            <div>
              <p className="text-sm text-foreground-400">Branch</p>
              <p className="text-lg font-semibold">{project.source_branch}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Navigation Links */}
      <div className="flex gap-2 flex-wrap">
        {[
          { label: "Deployments", href: `/projects/${project.id}/deployments`, icon: "solar:history-bold-duotone" },
          { label: "Env Variables", href: `/projects/${project.id}/env`, icon: "solar:key-bold-duotone" },
          { label: "Logs", href: `/projects/${project.id}/logs`, icon: "solar:document-text-bold-duotone" },
          { label: "Terminal", href: `/projects/${project.id}/terminal`, icon: "solar:monitor-bold-duotone" },
          { label: "Settings", href: `/projects/${project.id}/settings`, icon: "solar:settings-bold-duotone" },
        ].map((item) => (
          <Button
            key={item.href}
            variant="outline"
            size="sm"
            onPress={() => router.push(item.href)}
          >
            <Icon icon={item.icon} width={16} />
            {item.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
