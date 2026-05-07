"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  TextField, Label, Input, Button, Spinner,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

type Category = "app" | "database";
type SourceType = "github" | "upload";
type RuntimeType = "node" | "static" | "docker";
type ServiceType = "postgresql" | "mysql" | "redis" | "mongodb";

const serviceOptions: { type: ServiceType; label: string; icon: string; defaultPort: number; versions: string[] }[] = [
  { type: "postgresql", label: "PostgreSQL", icon: "solar:database-bold-duotone", defaultPort: 5432, versions: ["16", "15", "14"] },
  { type: "mysql", label: "MySQL", icon: "solar:database-bold-duotone", defaultPort: 3306, versions: ["8", "5.7"] },
  { type: "redis", label: "Redis", icon: "solar:bolt-bold-duotone", defaultPort: 6379, versions: ["7", "6"] },
  { type: "mongodb", label: "MongoDB", icon: "solar:database-bold-duotone", defaultPort: 27017, versions: ["7", "6", "5"] },
];

export default function NewServicePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") || "";

  const [category, setCategory] = useState<Category | null>(null);
  const [loading, setLoading] = useState(false);

  // App state
  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [sourceUrl, setSourceUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [runtimeType, setRuntimeType] = useState<RuntimeType>("node");
  const [appPort, setAppPort] = useState("");
  const [packageManager, setPackageManager] = useState<"auto"|"npm"|"bun"|"pnpm"|"yarn">("auto");
  const [zipFile, setZipFile] = useState<File | null>(null);

  // Database state
  const [dbName, setDbName] = useState("");
  const [dbType, setDbType] = useState<ServiceType>("postgresql");
  const [dbVersion, setDbVersion] = useState("16");
  const [dbPort, setDbPort] = useState("5432");
  const [dbUser, setDbUser] = useState("runpanel");
  const [dbPassword, setDbPassword] = useState("");
  const [dbDatabase, setDbDatabase] = useState("runpanel_db");

  const selectedDb = serviceOptions.find((o) => o.type === dbType)!;

  function handleDbTypeChange(t: ServiceType) {
    setDbType(t);
    const opt = serviceOptions.find((o) => o.type === t)!;
    setDbVersion(opt.versions[0]);
    setDbPort(opt.defaultPort.toString());
    setDbUser(t === "redis" ? "" : "runpanel");
    setDbDatabase(t === "redis" ? "0" : "runpanel_db");
    setDbPassword("");
  }

  async function handleCreateApp() {
    if (sourceType === "github" && !sourceUrl.trim()) { toast.error("Repository URL required"); return; }
    if (sourceType === "upload" && !zipFile) { toast.error("ZIP file required"); return; }

    setLoading(true);
    try {
      // Update project with app config
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          sourceUrl: sourceType === "github" ? sourceUrl.trim() : undefined,
          sourceBranch: branch || "main",
          runtimeType,
          port: appPort ? parseInt(appPort) : undefined,
          builderConfig: { packageManager: packageManager !== "auto" ? packageManager : undefined },
        }),
      });

      if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed"); return; }

      // Upload ZIP if needed
      if (sourceType === "upload" && zipFile) {
        const project = await res.json();
        const formData = new FormData();
        formData.append("file", zipFile);
        formData.append("projectSlug", project.slug);
        const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
        if (!uploadRes.ok) { const d = await uploadRes.json(); toast.error(d.error || "Upload failed"); return; }
      }

      // Clone if github
      if (sourceType === "github" && sourceUrl.trim()) {
        // The deploy will handle cloning
      }

      toast.success("App configured");
      router.push(`/projects/${projectId}`);
    } catch { toast.error("Failed"); }
    finally { setLoading(false); }
  }

  async function handleCreateDb() {
    if (!dbName.trim()) { toast.error("Service name required"); return; }

    setLoading(true);
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: dbName.trim(),
          type: dbType,
          version: dbVersion,
          port: parseInt(dbPort),
          projectId,
          credentials: {
            user: dbUser.trim() || undefined,
            password: dbPassword || undefined,
            database: dbDatabase.trim() || undefined,
          },
        }),
      });
      if (res.ok) { toast.success("Service created"); router.push(projectId ? `/projects/${projectId}` : "/home"); }
      else { const d = await res.json(); toast.error(d.error || "Failed"); }
    } catch { toast.error("Failed"); }
    finally { setLoading(false); }
  }

  // Step 1: Choose category
  if (!category) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Add to Project</h1>
          <p className="text-sm text-foreground-400">Choose what to add</p>
        </div>
        <div className="grid grid-cols-2 gap-4 max-w-lg">
          <Card className="cursor-pointer transition-all hover:border-purple-500/30" onClick={() => setCategory("app")}>
            <CardContent className="flex flex-col items-center py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/15 mb-3">
                <Icon icon="solar:code-bold-duotone" className="text-purple-400" width={24} />
              </div>
              <p className="font-semibold">App</p>
              <p className="text-xs text-foreground-400 mt-1">Deploy from GitHub or ZIP</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer transition-all hover:border-violet-500/30" onClick={() => setCategory("database")}>
            <CardContent className="flex flex-col items-center py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/15 mb-3">
                <Icon icon="solar:database-bold-duotone" className="text-violet-400" width={24} />
              </div>
              <p className="font-semibold">Database</p>
              <p className="text-xs text-foreground-400 mt-1">PostgreSQL, MySQL, Redis, MongoDB</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Step 2a: App config
  if (category === "app") {
    return (
      <div>
        <div className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="sm" onPress={() => setCategory(null)}><Icon icon="solar:arrow-left-linear" width={18} /></Button>
          <div>
            <h1 className="text-2xl font-bold">Add App</h1>
            <p className="text-sm text-foreground-400">Configure the application source and runtime</p>
          </div>
        </div>

        <div className="max-w-2xl space-y-6">
          {/* Source */}
          <Card>
            <CardHeader><CardTitle>Source</CardTitle><CardDescription>Where to get the code</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button variant={sourceType === "github" ? "primary" : "outline"} onPress={() => setSourceType("github")} size="sm"><Icon icon="solar:global-bold-duotone" width={16} />GitHub</Button>
                <Button variant={sourceType === "upload" ? "primary" : "outline"} onPress={() => setSourceType("upload")} size="sm"><Icon icon="solar:archive-bold-duotone" width={16} />Upload ZIP</Button>
              </div>
              {sourceType === "github" ? (
                <div className="space-y-4">
                  <TextField value={sourceUrl} onChange={setSourceUrl}><Label>Repository URL</Label><Input placeholder="https://github.com/user/repo" /></TextField>
                  <TextField value={branch} onChange={setBranch}><Label>Branch</Label><Input placeholder="main" /></TextField>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-foreground-400 mb-2">ZIP File</label>
                  <input type="file" accept=".zip" onChange={(e) => setZipFile(e.target.files?.[0] || null)}
                    className="block w-full text-sm text-foreground-400 file:mr-4 file:rounded-lg file:border-0 file:bg-purple-500/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-purple-400 hover:file:bg-purple-500/20 file:cursor-pointer" />
                  {zipFile && <p className="mt-2 text-sm text-foreground-400">Selected: {zipFile.name} ({(zipFile.size / 1024 / 1024).toFixed(1)} MB)</p>}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Runtime */}
          <Card>
            <CardHeader><CardTitle>Runtime</CardTitle><CardDescription>How to run the project</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                {(["node", "static", "docker"] as RuntimeType[]).map((rt) => (
                  <Button key={rt} variant={runtimeType === rt ? "primary" : "outline"} onPress={() => setRuntimeType(rt)} size="sm">
                    <Icon icon={rt === "node" ? "solar:code-bold-duotone" : rt === "static" ? "solar:document-bold-duotone" : "solar:box-minimalistic-bold-duotone"} width={16} />
                    {rt === "node" ? "Node.js" : rt === "static" ? "Static" : "Docker"}
                  </Button>
                ))}
              </div>
              {runtimeType === "node" && (
                <div>
                  <label className="block text-sm font-medium text-foreground-400 mb-2">Package Manager</label>
                  <div className="flex gap-2 flex-wrap">
                    {(["auto", "npm", "bun", "pnpm", "yarn"] as const).map((pm) => (
                      <Button key={pm} variant={packageManager === pm ? "primary" : "outline"} onPress={() => setPackageManager(pm)} size="sm">{pm === "auto" ? "Auto-detect" : pm}</Button>
                    ))}
                  </div>
                </div>
              )}
              <TextField value={appPort} onChange={setAppPort}><Label>Port (optional)</Label><Input placeholder="3000" type="number" /></TextField>
            </CardContent>
          </Card>

          <Button variant="primary" size="lg" className="w-full" isDisabled={loading} onPress={handleCreateApp}>
            {loading ? <Spinner /> : "Configure App"}
          </Button>
        </div>
      </div>
    );
  }

  // Step 2b: Database config
  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="sm" onPress={() => setCategory(null)}><Icon icon="solar:arrow-left-linear" width={18} /></Button>
        <div>
          <h1 className="text-2xl font-bold">Add Database</h1>
          <p className="text-sm text-foreground-400">Provision a managed database or cache</p>
        </div>
      </div>

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader><CardTitle>Type</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {serviceOptions.map((opt) => (
                <Button key={opt.type} variant={dbType === opt.type ? "primary" : "outline"} className="flex flex-col h-auto py-3" onPress={() => handleDbTypeChange(opt.type)}>
                  <Icon icon={opt.icon} width={24} /><span className="text-xs mt-1">{opt.label}</span>
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <TextField value={dbName} onChange={setDbName} autoFocus><Label>Service Name</Label><Input placeholder="my-database" /></TextField>
            <div>
              <label className="block text-sm font-medium text-foreground-400 mb-2">Version</label>
              <div className="flex gap-2">
                {selectedDb.versions.map((v) => (
                  <Button key={v} variant={dbVersion === v ? "primary" : "outline"} size="sm" onPress={() => setDbVersion(v)}>{v}</Button>
                ))}
              </div>
            </div>
            <TextField value={dbPort} onChange={setDbPort}><Label>Host Port</Label><Input type="number" /></TextField>
            {dbType !== "redis" && (
              <>
                <TextField value={dbUser} onChange={setDbUser}><Label>Username</Label><Input placeholder="runpanel" className="font-mono text-sm" /></TextField>
                <TextField value={dbDatabase} onChange={setDbDatabase}><Label>Database Name</Label><Input placeholder="runpanel_db" className="font-mono text-sm" /></TextField>
              </>
            )}
            <TextField value={dbPassword} onChange={setDbPassword}><Label>Password {!dbPassword && <span className="text-foreground-500 font-normal">(auto-generated if empty)</span>}</Label><Input placeholder="Leave empty to auto-generate" className="font-mono text-sm" /></TextField>
          </CardContent>
        </Card>

        <Button variant="primary" size="lg" className="w-full" isDisabled={loading} onPress={handleCreateDb}>
          {loading ? <Spinner /> : "Provision Database"}
        </Button>
      </div>
    </div>
  );
}
