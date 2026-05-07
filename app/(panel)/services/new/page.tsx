"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  TextField, Label, Input, Button, Spinner,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

type Category = "app" | "database" | "template-nginx" | "template-apache" | "template-caddy";
type SourceType = "github" | "upload";
type RuntimeType = "node" | "docker" | "custom";
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
  const [installCmd, setInstallCmd] = useState("");
  const [buildCmd, setBuildCmd] = useState("");
  const [startCmd, setStartCmd] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [dockerMode, setDockerMode] = useState<"custom" | string>("custom");

  // Docker templates
  const dockerTemplates = [
    {
      id: "nginx",
      label: "Nginx",
      icon: "solar:server-2-bold-duotone",
      description: "Web server / reverse proxy",
      fields: [
        { key: "serverName", label: "Server Name", placeholder: "localhost", default: "localhost" },
        { key: "rootDir", label: "Root Directory", placeholder: "/usr/share/nginx/html", default: "/usr/share/nginx/html" },
        { key: "configFile", label: "Config Path (optional)", placeholder: "nginx.conf", default: "" },
      ],
      image: "nginx",
      versions: ["1.27", "1.26", "1.25"],
      defaultPort: "80",
    },
    {
      id: "apache",
      label: "Apache",
      icon: "solar:server-2-bold-duotone",
      description: "HTTP server",
      fields: [
        { key: "documentRoot", label: "Document Root", placeholder: "/var/www/html", default: "/var/www/html" },
        { key: "serverAdmin", label: "Server Admin Email", placeholder: "admin@example.com", default: "" },
      ],
      image: "httpd",
      versions: ["2.4"],
      defaultPort: "80",
    },
    {
      id: "caddy",
      label: "Caddy",
      icon: "solar:shield-check-bold-duotone",
      description: "Auto-HTTPS web server",
      fields: [
        { key: "domain", label: "Domain", placeholder: "example.com", default: "" },
        { key: "rootDir", label: "Root Directory", placeholder: "/srv", default: "/srv" },
        { key: "caddyfile", label: "Caddyfile Path (optional)", placeholder: "Caddyfile", default: "" },
      ],
      image: "caddy",
      versions: ["2.9", "2.8", "2.7"],
      defaultPort: "80",
    },
  ];

  const [dockerTemplateVersion, setDockerTemplateVersion] = useState("");
  const [dockerTemplateFields, setDockerTemplateFields] = useState<Record<string, string>>({});

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
    if (runtimeType === "custom" && !startCmd.trim()) { toast.error("Start command is required for custom runtime"); return; }

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
          builderConfig: {
            packageManager: packageManager !== "auto" ? packageManager : undefined,
            installCmd: installCmd.trim() || undefined,
            buildCmd: buildCmd.trim() || undefined,
            startCmd: startCmd.trim() || undefined,
            // Docker template config
            ...(runtimeType === "docker" && dockerMode !== "custom" ? {
              dockerTemplate: dockerMode,
              dockerImage: `${dockerTemplates.find((t) => t.id === dockerMode)?.image}:${dockerTemplateVersion}`,
              dockerFields: dockerTemplateFields,
            } : {}),
          },
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

  // Handle template category selection — pre-fill docker config
  function selectTemplateCategory(tplId: string) {
    const tpl = dockerTemplates.find((t) => t.id === tplId);
    if (!tpl) return;
    setRuntimeType("docker");
    setDockerMode(tplId);
    setAppPort(tpl.defaultPort);
    setDockerTemplateVersion(tpl.versions[0]);
    const defaults: Record<string, string> = {};
    tpl.fields.forEach((f) => { defaults[f.key] = f.default; });
    setDockerTemplateFields(defaults);
    setCategory(`template-${tplId}` as Category);
  }

  // Step 1: Choose category
  if (!category) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Add to Project</h1>
          <p className="text-sm text-foreground-400">Choose what to add</p>
        </div>

        <p className="text-xs font-medium text-foreground-400 mb-3">Application</p>
        <div className="grid grid-cols-1 gap-4 max-w-2xl mb-6 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="cursor-pointer transition-all hover:border-purple-500/30" onClick={() => setCategory("app")}>
            <CardContent className="flex flex-col items-center py-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/15 mb-2">
                <Icon icon="solar:code-bold-duotone" className="text-purple-400" width={22} />
              </div>
              <p className="font-semibold text-sm">App</p>
              <span className="mt-1.5 inline-block rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] font-medium text-purple-300">Build your project</span>
            </CardContent>
          </Card>
          {dockerTemplates.map((tpl) => (
            <Card key={tpl.id} className="cursor-pointer transition-all hover:border-purple-500/30" onClick={() => selectTemplateCategory(tpl.id)}>
              <CardContent className="flex flex-col items-center py-6 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/15 mb-2">
                  <Icon icon={tpl.icon} className="text-purple-400" width={22} />
                </div>
                <p className="font-semibold text-sm">{tpl.label}</p>
                <p className="text-[11px] text-foreground-400 mt-1">{tpl.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="text-xs font-medium text-foreground-400 mb-3">Database</p>
        <div className="grid grid-cols-2 gap-4 max-w-2xl sm:grid-cols-3 lg:grid-cols-4">
          {serviceOptions.map((opt) => (
            <Card key={opt.type} className="cursor-pointer transition-all hover:border-violet-500/30" onClick={() => setCategory("database")}>
              <CardContent className="flex flex-col items-center py-6 text-center" onClick={() => { handleDbTypeChange(opt.type); setCategory("database"); }}>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 mb-2">
                  <Icon icon={opt.icon} className="text-violet-400" width={22} />
                </div>
                <p className="font-semibold text-sm">{opt.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Step 2: Template config (Nginx, Apache, Caddy)
  if (category.startsWith("template-")) {
    const tplId = category.replace("template-", "");
    const tpl = dockerTemplates.find((t) => t.id === tplId);
    if (!tpl) { setCategory(null); return null; }

    return (
      <div>
        <div className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="sm" onPress={() => setCategory(null)}><Icon icon="solar:arrow-left-linear" width={18} /></Button>
          <div>
            <h1 className="text-2xl font-bold">{tpl.label}</h1>
            <p className="text-sm text-foreground-400">{tpl.description}</p>
          </div>
        </div>

        <div className="max-w-2xl space-y-6">
          <Card>
            <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground-400 mb-2">Version</label>
                <div className="flex gap-2">
                  {tpl.versions.map((v) => (
                    <Button key={v} variant={dockerTemplateVersion === v ? "primary" : "outline"} size="sm" onPress={() => setDockerTemplateVersion(v)}>{v}</Button>
                  ))}
                </div>
              </div>
              <TextField value={appPort} onChange={setAppPort}><Label>Port</Label><Input type="number" placeholder={tpl.defaultPort} /></TextField>
              {tpl.fields.map((f) => (
                <TextField key={f.key} value={dockerTemplateFields[f.key] || ""} onChange={(val) => setDockerTemplateFields((prev) => ({ ...prev, [f.key]: val }))}>
                  <Label>{f.label}</Label>
                  <Input placeholder={f.placeholder} className="font-mono text-sm" />
                </TextField>
              ))}
            </CardContent>
          </Card>

          <Button variant="primary" size="lg" className="w-full" isDisabled={loading} onPress={handleCreateApp}>
            {loading ? <Spinner /> : `Deploy ${tpl.label}`}
          </Button>
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
              <div className="flex gap-2 flex-wrap">
                {([
                  { id: "node" as RuntimeType, label: "Node.js", icon: "solar:code-bold-duotone" },
                  { id: "docker" as RuntimeType, label: "Docker", icon: "solar:box-minimalistic-bold-duotone" },
                  { id: "custom" as RuntimeType, label: "Custom", icon: "solar:settings-bold-duotone" },
                ]).map((rt) => (
                  <Button key={rt.id} variant={runtimeType === rt.id ? "primary" : "outline"} onPress={() => setRuntimeType(rt.id)} size="sm">
                    <Icon icon={rt.icon} width={16} />
                    {rt.label}
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

              {runtimeType === "docker" && (
                <p className="text-xs text-foreground-500">Your project must include a Dockerfile. Docker templates are available from the main selection screen.</p>
              )}

              <TextField value={appPort} onChange={setAppPort}><Label>Port (optional)</Label><Input placeholder="3000" type="number" /></TextField>

              {/* Custom commands — always shown for custom, optional for node */}
              {(runtimeType === "custom" || runtimeType === "node") && (
                <div className="space-y-3 pt-2 border-t border-white/[0.07]">
                  <p className="text-xs font-medium text-foreground-400">
                    {runtimeType === "custom" ? "Commands (required for custom runtime)" : "Advanced (optional overrides)"}
                  </p>
                  <p className="text-[11px] text-foreground-500">One command per line. They run in order.</p>
                  <div>
                    <label className="block text-sm font-medium text-foreground-400 mb-1">Install Commands</label>
                    <textarea value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} rows={2} placeholder={runtimeType === "node" ? "auto-detected" : "pip install -r requirements.txt\nnpm install -g pm2"} className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-3 py-2 font-mono text-sm text-foreground-300 outline-none focus:border-purple-500/30 resize-y" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground-400 mb-1">Build Commands</label>
                    <textarea value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} rows={2} placeholder={runtimeType === "node" ? "auto-detected" : "python -m compileall .\nnpm run build"} className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-3 py-2 font-mono text-sm text-foreground-300 outline-none focus:border-purple-500/30 resize-y" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground-400 mb-1">Start Command {runtimeType === "custom" && <span className="text-danger">*</span>}</label>
                    <textarea value={startCmd} onChange={(e) => setStartCmd(e.target.value)} rows={1} placeholder={runtimeType === "node" ? "auto-detected" : "python app.py"} className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-3 py-2 font-mono text-sm text-foreground-300 outline-none focus:border-purple-500/30 resize-y" />
                    <p className="text-[11px] text-foreground-500 mt-1">Only the first line is used as the process start command.</p>
                  </div>
                </div>
              )}
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
