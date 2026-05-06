"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

type SourceType = "github" | "upload";
type RuntimeType = "node" | "static" | "docker";

export default function NewProjectPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [sourceUrl, setSourceUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [runtimeType, setRuntimeType] = useState<RuntimeType>("node");
  const [port, setPort] = useState("");
  const [packageManager, setPackageManager] = useState<"auto" | "npm" | "bun" | "pnpm" | "yarn">("auto");
  const [zipFile, setZipFile] = useState<File | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      toast.error("Project name is required");
      return;
    }
    if (sourceType === "github" && !sourceUrl.trim()) {
      toast.error("GitHub URL is required");
      return;
    }
    if (sourceType === "upload" && !zipFile) {
      toast.error("ZIP file is required");
      return;
    }

    setLoading(true);
    try {
      // Create project
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          sourceType,
          sourceUrl: sourceType === "github" ? sourceUrl.trim() : undefined,
          sourceBranch: branch || "main",
          runtimeType,
          port: port ? parseInt(port) : undefined,
          builderConfig: {
            packageManager: packageManager !== "auto" ? packageManager : undefined,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create project");
        return;
      }

      const project = await res.json();

      // Upload ZIP if needed
      if (sourceType === "upload" && zipFile) {
        const formData = new FormData();
        formData.append("file", zipFile);
        formData.append("projectSlug", project.slug);

        const uploadRes = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) {
          const data = await uploadRes.json();
          toast.error(data.error || "Failed to upload file");
          return;
        }
      }

      toast.success("Project created successfully");
      router.push(`/projects/${project.id}`);
    } catch {
      toast.error("Failed to create project");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">New Project</h1>
        <p className="text-sm text-foreground-400">
          Deploy a new application from GitHub or a ZIP file
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Project Name */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:tag-bold-duotone" width={24} className="text-primary" />
              <div>
                <CardTitle>Project Info</CardTitle>
                <CardDescription>Give your project a name</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <TextField value={name} onChange={setName} autoFocus>
              <Label>Project Name</Label>
              <Input />
            </TextField>
          </CardContent>
        </Card>

        {/* Source */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:code-bold-duotone" width={24} className="text-primary" />
              <div>
                <CardTitle>Source</CardTitle>
                <CardDescription>Where to get the code</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={sourceType === "github" ? "primary" : "outline"}
                onPress={() => setSourceType("github")}
                size="sm"
              >
                <Icon icon="solar:global-bold-duotone" width={16} />
                GitHub
              </Button>
              <Button
                variant={sourceType === "upload" ? "primary" : "outline"}
                onPress={() => setSourceType("upload")}
                size="sm"
              >
                <Icon icon="solar:archive-bold-duotone" width={16} />
                Upload ZIP
              </Button>
            </div>

            {sourceType === "github" ? (
              <div className="space-y-4">
                <TextField value={sourceUrl} onChange={setSourceUrl}>
                  <Label>Repository URL</Label>
                  <Input placeholder="https://github.com/user/repo" />
                </TextField>
                <TextField value={branch} onChange={setBranch}>
                  <Label>Branch</Label>
                  <Input placeholder="main" />
                </TextField>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-foreground-400 mb-2">
                  ZIP File
                </label>
                <input
                  type="file"
                  accept=".zip"
                  onChange={(e) => setZipFile(e.target.files?.[0] || null)}
                  className="block w-full text-sm text-foreground-400
                    file:mr-4 file:rounded-lg file:border-0
                    file:bg-primary/10 file:px-4 file:py-2
                    file:text-sm file:font-medium file:text-primary
                    hover:file:bg-primary/20 file:cursor-pointer"
                />
                {zipFile && (
                  <p className="mt-2 text-sm text-foreground-400">
                    Selected: {zipFile.name} ({(zipFile.size / 1024 / 1024).toFixed(1)} MB)
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Runtime */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:settings-bold-duotone" width={24} className="text-primary" />
              <div>
                <CardTitle>Runtime</CardTitle>
                <CardDescription>How to run the project</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              {(["node", "static", "docker"] as RuntimeType[]).map((rt) => (
                <Button
                  key={rt}
                  variant={runtimeType === rt ? "primary" : "outline"}
                  onPress={() => setRuntimeType(rt)}
                  size="sm"
                >
                  <Icon
                    icon={
                      rt === "node" ? "solar:code-bold-duotone" :
                      rt === "static" ? "solar:document-bold-duotone" :
                      "solar:box-minimalistic-bold-duotone"
                    }
                    width={16}
                  />
                  {rt === "node" ? "Node.js" : rt === "static" ? "Static" : "Docker"}
                </Button>
              ))}
            </div>

            {runtimeType === "node" && (
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

            <TextField value={port} onChange={setPort}>
              <Label>Port (optional)</Label>
              <Input placeholder="3000" type="number" />
            </TextField>
          </CardContent>
        </Card>

        {/* Submit */}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          isDisabled={loading}
          onPress={handleCreate}
        >
          {loading ? <Spinner /> : "Create Project"}
        </Button>
      </div>
    </div>
  );
}
