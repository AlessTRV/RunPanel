"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  TextField,
  Label,
  Input,
  Button,
  Spinner,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

interface Project {
  id: string;
  name: string;
  slug: string;
  source_branch: string;
  runtime_type: string;
  port: number | null;
  auto_deploy: number;
  webhook_secret: string;
  builder_config: string;
}

export default function ProjectSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [port, setPort] = useState("");
  const [packageManager, setPackageManager] = useState<"auto" | "npm" | "bun" | "pnpm" | "yarn">("auto");

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((p) => {
        setProject(p);
        setName(p.name);
        setBranch(p.source_branch);
        setPort(p.port?.toString() || "");
        try {
          const bc = JSON.parse(p.builder_config || "{}");
          setPackageManager(bc.packageManager || "auto");
        } catch { /* ignore */ }
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          sourceBranch: branch,
          port: port ? parseInt(port) : null,
          builderConfig: {
            packageManager: packageManager !== "auto" ? packageManager : undefined,
          },
        }),
      });
      if (res.ok) {
        toast.success("Settings saved");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this project? This action cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Project deleted");
        router.push("/projects");
      } else {
        toast.error("Failed to delete project");
      }
    } catch {
      toast.error("Failed to delete project");
    } finally {
      setDeleting(false);
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
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Project Settings</h1>
        <p className="text-sm text-foreground-400">Configure {project.name}</p>
      </div>

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>Basic project configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <TextField value={name} onChange={setName}>
              <Label>Project Name</Label>
              <Input />
            </TextField>
            <TextField value={branch} onChange={setBranch}>
              <Label>Branch</Label>
              <Input />
            </TextField>
            <TextField value={port} onChange={setPort}>
              <Label>Port</Label>
              <Input type="number" placeholder="3000" />
            </TextField>
            {project.runtime_type === "node" && (
              <div>
                <label className="block text-sm font-medium text-foreground-400 mb-2">
                  Package Manager
                </label>
                <div className="flex gap-2 flex-wrap">
                  {(["auto", "npm", "bun", "pnpm", "yarn"] as const).map((pm) => (
                    <Button
                      key={pm}
                      variant={packageManager === pm ? "primary" : "outline"}
                      onPress={() => setPackageManager(pm)}
                      size="sm"
                    >
                      {pm === "auto" ? "Auto-detect" : pm}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <Button variant="primary" isDisabled={saving} onPress={handleSave}>
              {saving ? <Spinner /> : "Save Changes"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Webhook</CardTitle>
            <CardDescription>Auto-deploy on GitHub push</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg bg-content2 p-3 font-mono text-xs break-all">
              <p className="text-foreground-400 mb-1">Webhook URL:</p>
              <p>{typeof window !== "undefined" ? window.location.origin : ""}/api/webhooks/github/{projectId}</p>
            </div>
            <div className="rounded-lg bg-content2 p-3 font-mono text-xs break-all">
              <p className="text-foreground-400 mb-1">Secret:</p>
              <p>{project.webhook_secret}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-danger/30">
          <CardHeader>
            <CardTitle className="text-danger">Danger Zone</CardTitle>
            <CardDescription>Irreversible actions</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="danger" isDisabled={deleting} onPress={handleDelete}>
              {deleting ? <Spinner /> : <Icon icon="solar:trash-bin-trash-bold-duotone" width={18} />}
              Delete Project
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
