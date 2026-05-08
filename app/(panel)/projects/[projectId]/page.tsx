"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  Button, Spinner, TextField, Label, Input,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/StatusBadge";

// ── Types ──

interface Project {
  id: string; name: string; slug: string;
  source_type: string; source_url: string | null; source_branch: string;
  runtime_type: string; status: string; port: number | null;
  auto_deploy: number; deploy_count: number; last_deploy_at: string | null;
  webhook_secret: string; builder_config: string;
}

interface ProcessInfo { running: boolean; pid?: number; uptime?: number; memory?: number; cpu?: number; }

interface Deployment {
  id: string; trigger_type: string; commit_sha: string | null; commit_message: string | null;
  status: string; started_at: string; finished_at: string | null; error_message: string | null;
}

interface EnvVar { key: string; value: string; }

// ── Helpers ──

function fmtUptime(s: number) { const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60); return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`; }
function fmtBytes(b: number) { const mb = b/(1024*1024); return mb >= 1024 ? `${(mb/1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`; }
function fmtDuration(a: string, b: string) { const ms = new Date(b).getTime() - new Date(a).getTime(); const s = Math.round(ms/1000); return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`; }

type TabId = "logs" | "deployments" | "env" | "terminal" | "settings";

// ── Main Page ──

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  const [project, setProject] = useState<Project | null>(null);
  const [processInfo, setProcessInfo] = useState<ProcessInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("logs");
  const [showProjectSettings, setShowProjectSettings] = useState(searchParams.get("tab") === "settings");

  // Logs state
  const [logs, setLogs] = useState<string[]>([]);
  const logsRef = useRef<HTMLDivElement>(null);
  const seenLogsRef = useRef(new Set<string>());

  // Deployments state
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(false);

  // Env state
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);

  // Terminal state
  const [shellActive, setShellActive] = useState(false);
  const [shellStarting, setShellStarting] = useState(false);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [termInput, setTermInput] = useState("");
  const termRef = useRef<HTMLDivElement>(null);



  // Settings state
  const [settName, setSettName] = useState("");
  const [settBranch, setSettBranch] = useState("");
  const [settPort, setSettPort] = useState("");
  const [settPm, setSettPm] = useState<"auto"|"npm"|"bun"|"pnpm"|"yarn">("auto");
  const [settAppName, setSettAppName] = useState("");
  const [settInstallCmd, setSettInstallCmd] = useState("");
  const [settBuildCmd, setSettBuildCmd] = useState("");
  const [settStartCmd, setSettStartCmd] = useState("");
  const [settSaving, setSettSaving] = useState(false);
  const [settDeleting, setSettDeleting] = useState(false);

  // ── Load project ──
  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((p) => {
        setProject(p);
        setSettName(p.name); setSettAppName(p.app_name || ""); setSettBranch(p.source_branch); setSettPort(p.port?.toString() || "");
        try { const bc = JSON.parse(p.builder_config || "{}"); setSettPm(bc.packageManager || "auto"); setSettInstallCmd(bc.installCmd || ""); setSettBuildCmd(bc.buildCmd || ""); setSettStartCmd(bc.startCmd || ""); } catch {}
      })
      .catch(() => router.push("/home"))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  // ── Poll status (always running, ref tracks previous for toasts) ──
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!project) return;
    prevStatusRef.current = project.status;
  }, [project]);

  useEffect(() => {
    const controller = new AbortController();
    const interval = setInterval(async () => {
      try {
        const [prRes, stRes] = await Promise.all([
          fetch(`/api/projects/${projectId}`, { signal: controller.signal }),
          fetch(`/api/projects/${projectId}/status`, { signal: controller.signal }),
        ]);
        const pr = prRes.ok ? await prRes.json() : null;
        const st = stRes.ok ? await stRes.json() : null;
        if (pr) {
          const prev = prevStatusRef.current;
          prevStatusRef.current = pr.status;
          setProject(pr);
          if (prev === "deploying" && pr.status === "running") toast.success("Deploy completed");
          if (prev === "deploying" && pr.status === "error") toast.error("Deploy failed");
        }
        if (st?.process) setProcessInfo(st.process);
      } catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
    }, 5000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [projectId]);

  // ── Logs polling (batched updates, AbortController) ──
  useEffect(() => {
    if (activeTab !== "logs") return;
    seenLogsRef.current.clear(); setLogs([]);
    const controller = new AbortController();
    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/logs?source=process`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        const newLogs: string[] = [];
        for (const l of (data.logs as string[] || [])) {
          if (!seenLogsRef.current.has(l)) { seenLogsRef.current.add(l); newLogs.push(l); }
        }
        if (newLogs.length > 0) setLogs(p => [...p, ...newLogs]);
      } catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
    };
    poll();
    const i = setInterval(poll, 3000);
    return () => { controller.abort(); clearInterval(i); };
  }, [activeTab, projectId]);

  useEffect(() => { if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight; }, [logs]);

  // ── Load deployments on tab switch ──
  useEffect(() => {
    if (activeTab !== "deployments") return;
    setDeploymentsLoading(true);
    fetch(`/api/projects/${projectId}/logs`)
      .then(r => r.ok ? r.json() : [])
      .then(setDeployments)
      .finally(() => setDeploymentsLoading(false));
  }, [activeTab, projectId]);

  // ── Load env on tab switch ──
  useEffect(() => {
    if (activeTab !== "env") return;
    setEnvLoading(true);
    fetch(`/api/projects/${projectId}/env?reveal=true`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (Array.isArray(data)) {
          setEnvVars(data.map((v: {key:string;value:string}) => ({key:v.key,value:v.value})));
        }
      })
      .catch((e) => toast.error(`Failed to load env vars: ${e.message}`))
      .finally(() => setEnvLoading(false));
  }, [activeTab, projectId]);

  // ── Terminal polling ──

  useEffect(() => {
    if (activeTab !== "terminal" || !shellActive) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/terminal`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (data.output) setTermLines(p => [...p, data.output]);
        if (!data.active) setShellActive(false);
      } catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [activeTab, shellActive, projectId]);

  useEffect(() => { if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [termLines]);

  // ── Actions ──
  async function handleDeploy(mode: "deploy"|"rebuild" = "deploy") {
    if (mode === "rebuild" && !confirm("Re-Build will delete node_modules, .next and all caches. Continue?")) return;
    setDeploying(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/deploy`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({mode}) });
      const data = await res.json();
      if (res.ok) { toast.success(mode === "rebuild" ? "Re-Build started" : "Deploy started"); setProject(p => p ? {...p, status:"deploying"} : p); }
      else toast.error(data.error || "Failed");
    } catch { toast.error("Failed"); }
    finally { setDeploying(false); }
  }

  async function handleControl(action: "start"|"stop"|"restart") {
    try {
      const res = await fetch(`/api/projects/${projectId}/control`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({action}) });
      if (res.ok) { toast.success(`${action} triggered`); const u = await fetch(`/api/projects/${projectId}`).then(r => r.json()); setProject(u); }
      else { const d = await res.json(); toast.error(d.error || `Failed to ${action}`); }
    } catch { toast.error(`Failed to ${action}`); }
  }

  async function handleEnvSave() {
    const valid = envVars.filter(v => v.key.trim());
    if (valid.length === 0) { toast.error("No variables to save"); return; }
    setEnvSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/env`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({vars:valid}) });
      if (res.ok) { const d = await res.json(); toast.success(`${d.count || valid.length} variable(s) saved`); setEnvVars(valid); }
      else { const d = await res.json(); toast.error(d.error || "Failed to save"); }
    } catch (e) { toast.error(`Save failed: ${e instanceof Error ? e.message : "unknown error"}`); }
    finally { setEnvSaving(false); }
  }

  function handleImportEnv() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".env,.env.local,.env.production";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
      const text = await file.text();
      const parsed = text.split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => { const eq = l.indexOf("="); if (eq === -1) return null; return { key: l.slice(0,eq).trim(), value: l.slice(eq+1).trim().replace(/^["']|["']$/g,"") }; }).filter(Boolean) as EnvVar[];
      setEnvVars(prev => { const ex = new Set(prev.map(v=>v.key)); return [...prev, ...parsed.filter(v=>!ex.has(v.key))]; });
      toast.success(`Imported ${parsed.length} variables`);
    };
    input.click();
  }

  async function handleSettSave() {
    setSettSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ name: settName.trim(), appName: settAppName.trim() || null, sourceBranch: settBranch, port: settPort ? parseInt(settPort) : null, builderConfig: { packageManager: settPm !== "auto" ? settPm : undefined, installCmd: settInstallCmd.trim() || undefined, buildCmd: settBuildCmd.trim() || undefined, startCmd: settStartCmd.trim() || undefined } }) });
      if (res.ok) toast.success("Settings saved"); else { const d = await res.json(); toast.error(d.error || "Failed"); }
    } catch { toast.error("Failed"); }
    finally { setSettSaving(false); }
  }

  async function handleDelete() {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    setSettDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (res.ok) { toast.success("Project deleted"); router.push("/home"); } else toast.error("Failed");
    } catch { toast.error("Failed"); }
    finally { setSettDeleting(false); }
  }

  async function startShell() {
    setShellStarting(true); setTermLines([]);
    try {
      const res = await fetch(`/api/projects/${projectId}/terminal`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({action:"start"}) });
      const data = await res.json();
      if (res.ok) { setShellActive(true); setTermLines([`Shell started in ${data.cwd}\n\n`]); }
    } catch { setTermLines(["Failed to start shell\n"]); }
    finally { setShellStarting(false); }
  }

  async function stopShell() {
    try { await fetch(`/api/projects/${projectId}/terminal`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({action:"stop"}) }); } catch {}
    setShellActive(false); setTermLines(p => [...p, "\n[Session ended]\n"]);
  }

  if (loading || !project) return <div className="flex justify-center py-20"><Spinner /></div>;

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "logs", label: "Logs", icon: "solar:document-text-bold-duotone" },
    { id: "deployments", label: "Deployments", icon: "solar:history-bold-duotone" },
    { id: "env", label: "Env", icon: "solar:key-bold-duotone" },
    ...(project.runtime_type === "docker" ? [{ id: "terminal" as TabId, label: "Terminal", icon: "solar:monitor-bold-duotone" }] : []),
    { id: "settings", label: "Settings", icon: "solar:settings-bold-duotone" },
  ];

  return (
    <div>
      {/* Header + Controls */}
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center">
        <Button variant="ghost" size="sm" onPress={() => router.push("/home")}><Icon icon="solar:arrow-left-linear" width={18} /></Button>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/15"><Icon icon="solar:box-bold-duotone" className="text-purple-400" width={22} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold truncate">{project.name}</h1>
            <StatusBadge status={project.status} />
            <button onClick={() => setShowProjectSettings(true)} className="text-foreground-500 hover:text-foreground-300 transition-colors" title="Project settings" aria-label="Project settings"><Icon icon="solar:settings-bold-duotone" width={16} /></button>
          </div>
          <p className="text-xs text-foreground-400">{project.runtime_type} · :{project.port || "auto"} · {project.source_branch}</p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap">
          <Button variant="primary" size="sm" isDisabled={deploying || project.status === "deploying"} onPress={() => handleDeploy("deploy")}>{deploying ? <Spinner /> : <Icon icon="solar:upload-bold-duotone" width={16} />}Deploy</Button>
          <Button variant="outline" size="sm" isDisabled={deploying || project.status === "deploying"} onPress={() => handleDeploy("rebuild")}><Icon icon="solar:refresh-circle-bold-duotone" width={16} />Re-Build</Button>
          {(project.status === "running" || project.status === "error") && (<><Button variant="outline" size="sm" onPress={() => handleControl("restart")}><Icon icon="solar:refresh-bold-duotone" width={16} />Restart</Button><Button variant="danger" size="sm" onPress={() => handleControl("stop")}><Icon icon="solar:stop-bold-duotone" width={16} />Stop</Button></>)}
          {(project.status === "stopped" || project.status === "error") && (<Button variant="secondary" size="sm" onPress={() => handleControl("start")}><Icon icon="solar:play-bold-duotone" width={16} />Start</Button>)}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 mb-5">
        {[
          { icon: "solar:shield-check-bold-duotone", color: processInfo?.running ? "text-emerald-400" : "text-foreground-400", label: "Status", value: processInfo?.running ? "Online" : "Offline", sub: processInfo?.pid ? `PID ${processInfo.pid}` : "" },
          { icon: "solar:clock-circle-bold-duotone", color: "text-purple-400", label: "Uptime", value: processInfo?.uptime ? fmtUptime(processInfo.uptime) : "—", sub: "" },
          { icon: "solar:server-bold-duotone", color: "text-violet-400", label: "Memory", value: processInfo?.memory ? fmtBytes(processInfo.memory) : "—", sub: "" },
          { icon: "solar:cpu-bold-duotone", color: "text-amber-400", label: "CPU", value: processInfo?.cpu != null ? `${processInfo.cpu}%` : "—", sub: "" },
        ].map((stat, i) => (
          <div key={stat.label} className={`flex flex-col items-center text-center py-2 ${i > 0 ? "border-l border-white/[0.07]" : ""}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <Icon icon={stat.icon} className={stat.color} width={14} />
              <p className="text-xs font-medium text-foreground-500">{stat.label}</p>
            </div>
            <p className="text-2xl font-bold">{stat.value}</p>
            {stat.sub && <p className="text-[11px] text-foreground-500 mt-0.5">{stat.sub}</p>}
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-white/[0.07]">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === tab.id ? "border-primary text-primary" : "border-transparent text-foreground-400 hover:text-foreground hover:bg-white/5 rounded-t-lg"}`}>
            <Icon icon={tab.icon} width={15} />{tab.label}
          </button>
        ))}
      </div>

      {/* ═══ TAB: Logs ═══ */}
      {activeTab === "logs" && (
        <div ref={logsRef} className="h-[280px] sm:h-[400px] overflow-auto rounded-xl border border-white/[0.07] bg-black/50 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-4 font-mono text-xs text-green-400/80">
          {logs.length === 0 ? <p className="text-foreground-500">Waiting for process logs...</p> : logs.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all leading-5">{l}</div>)}
        </div>
      )}

      {/* ═══ TAB: Deployments ═══ */}
      {activeTab === "deployments" && (
        <div>
          {deploymentsLoading ? <div className="flex justify-center py-12"><Spinner /></div> : deployments.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-foreground-400"><Icon icon="solar:history-bold-duotone" width={40} className="mb-2 opacity-40" /><p>No deployments yet</p></div>
          ) : (
            <div className="space-y-3">
              {deployments.map((d) => <DeploymentCard key={d.id} deployment={d} />)}
            </div>
          )}
        </div>
      )}

      {/* ═══ TAB: Env ═══ */}
      {activeTab === "env" && (
        <div>
          {project.runtime_type === "docker" && (
            <div className="mb-4 flex items-start gap-3 rounded-xl bg-purple-500/10 border border-purple-500/15 px-4 py-3">
              <Icon icon="solar:info-circle-bold-duotone" className="text-purple-400 flex-shrink-0 mt-0.5" width={18} />
              <p className="text-xs text-foreground-300">
                This service runs in a Docker container. Use <code className="bg-white/[0.08] px-1.5 py-0.5 rounded text-purple-300 font-mono">host.docker.internal</code> instead of <code className="bg-white/[0.08] px-1.5 py-0.5 rounded font-mono">localhost</code> to reach services on the host machine (e.g. databases).
              </p>
            </div>
          )}
          <div className="mb-4 flex gap-2 justify-end">
            <Button variant="outline" size="sm" onPress={handleImportEnv}><Icon icon="solar:import-bold-duotone" width={16} />Import .env</Button>
            <Button variant="outline" size="sm" onPress={() => setEnvVars(p => [...p, {key:"",value:""}])}><Icon icon="solar:add-circle-bold-duotone" width={16} />Add</Button>
          </div>
          {envLoading ? <div className="flex justify-center py-12"><Spinner /></div> : envVars.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-foreground-400"><Icon icon="solar:key-bold-duotone" width={40} className="mb-2 opacity-40" /><p>No environment variables</p></div>
          ) : (
            <Card>
              <CardContent className="space-y-3 py-4">
                {envVars.map((v, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <div className="flex-1"><TextField value={v.key} onChange={(val) => { const u = [...envVars]; u[i] = {...u[i], key: val}; setEnvVars(u); }}><Label className="text-xs">Key</Label><Input placeholder="VARIABLE_NAME" className="font-mono text-sm" /></TextField></div>
                    <div className="flex-[2]"><TextField value={v.value} onChange={(val) => { const u = [...envVars]; u[i] = {...u[i], value: val}; setEnvVars(u); }}><Label className="text-xs">Value</Label><Input placeholder="value" className="font-mono text-sm" /></TextField></div>
                    <Button variant="ghost" size="sm" isIconOnly onPress={() => setEnvVars(envVars.filter((_,j)=>j!==i))} className="mb-0.5"><Icon icon="solar:trash-bin-trash-bold-duotone" width={18} className="text-danger" /></Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          {envVars.length > 0 && <div className="mt-4 flex justify-end"><Button variant="primary" isDisabled={envSaving} onPress={handleEnvSave}>{envSaving ? <Spinner /> : "Save Variables"}</Button></div>}
        </div>
      )}

      {/* ═══ TAB: Terminal (Shell only) ═══ */}
      {activeTab === "terminal" && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            {!shellActive && <Button variant="primary" size="sm" isDisabled={shellStarting} onPress={startShell}>{shellStarting ? <Spinner /> : <Icon icon="solar:play-bold-duotone" width={16} />}Start Shell</Button>}
            {shellActive && <Button variant="danger" size="sm" onPress={stopShell}><Icon icon="solar:stop-bold-duotone" width={16} />Stop Shell</Button>}
          </div>
          <div ref={termRef} className="h-[280px] sm:h-[400px] overflow-auto rounded-xl border border-white/[0.07] bg-black/50 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-4 font-mono text-sm text-green-400/80">
            {termLines.length === 0 ? <p className="text-foreground-500">Click &quot;Start Shell&quot; to open a shell inside the Docker container.</p> : termLines.map((l, i) => <span key={i} className="whitespace-pre-wrap break-all">{l}</span>)}
          </div>
          {shellActive && (
            <div className="mt-2 flex gap-2">
              <span className="flex items-center font-mono text-sm text-green-400">$</span>
              <input type="text" value={termInput} onChange={e => setTermInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { const cmd = termInput; setTermInput(""); setTermLines(p => [...p, `$ ${cmd}\n`]); fetch(`/api/projects/${projectId}/terminal`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({input:cmd+"\n"})}); } }} placeholder="Type a command..." autoFocus className="flex-1 rounded-lg border border-white/[0.07] bg-black/50 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] px-3 py-2 font-mono text-sm text-green-400/80 outline-none focus:border-primary/50" />
            </div>
          )}
        </div>
      )}

      {/* ═══ TAB: Settings (App/Service settings) ═══ */}
      {activeTab === "settings" && (
        <div className="max-w-2xl space-y-6">
          <Card>
            <CardHeader><CardTitle>App Configuration</CardTitle><CardDescription>Source, runtime and build settings</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <TextField value={settAppName} onChange={setSettAppName}><Label>App Name</Label><Input placeholder={project.slug} /></TextField>
              <TextField value={settBranch} onChange={setSettBranch}><Label>Branch</Label><Input /></TextField>
              <TextField value={settPort} onChange={setSettPort}><Label>Port</Label><Input type="number" placeholder="3000" /></TextField>
              {project.runtime_type === "node" && (
                <div>
                  <label className="block text-sm font-medium text-foreground-400 mb-2">Package Manager</label>
                  <div className="flex gap-2 flex-wrap">
                    {(["auto","npm","bun","pnpm","yarn"] as const).map(pm => <Button key={pm} variant={settPm === pm ? "primary" : "outline"} onPress={() => setSettPm(pm)} size="sm">{pm === "auto" ? "Auto-detect" : pm}</Button>)}
                  </div>
                </div>
              )}
              {project.runtime_type !== "docker" && (
                <div className="space-y-3 pt-3 border-t border-white/[0.07]">
                  <p className="text-xs font-medium text-foreground-400">{project.runtime_type === "custom" ? "Commands" : "Custom Commands (optional overrides)"}</p>
                  <p className="text-[11px] text-foreground-500">One command per line. They run in order.</p>
                  <div>
                    <label className="block text-sm font-medium text-foreground-400 mb-1">Install Commands</label>
                    <textarea value={settInstallCmd} onChange={(e) => setSettInstallCmd(e.target.value)} rows={2} placeholder={project.runtime_type === "node" ? "auto-detected" : "pip install -r requirements.txt"} className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-3 py-2 font-mono text-sm text-foreground-300 outline-none focus:border-purple-500/30 resize-y" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground-400 mb-1">Build Commands</label>
                    <textarea value={settBuildCmd} onChange={(e) => setSettBuildCmd(e.target.value)} rows={2} placeholder={project.runtime_type === "node" ? "auto-detected" : "python -m compileall ."} className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-3 py-2 font-mono text-sm text-foreground-300 outline-none focus:border-purple-500/30 resize-y" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground-400 mb-1">Start Command</label>
                    <textarea value={settStartCmd} onChange={(e) => setSettStartCmd(e.target.value)} rows={1} placeholder={project.runtime_type === "node" ? "auto-detected" : "python app.py"} className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-3 py-2 font-mono text-sm text-foreground-300 outline-none focus:border-purple-500/30 resize-y" />
                    <p className="text-[11px] text-foreground-500 mt-1">Only the first line is used as the process start command.</p>
                  </div>
                </div>
              )}
              <Button variant="primary" isDisabled={settSaving} onPress={handleSettSave}>{settSaving ? <Spinner /> : "Save Changes"}</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Webhook</CardTitle><CardDescription>Auto-deploy on GitHub push</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border border-white/[0.07] bg-black/40 backdrop-blur-xl p-3 font-mono text-xs break-all">
                <p className="text-foreground-400 mb-1">URL:</p>
                <p>{typeof window !== "undefined" ? window.location.origin : ""}/api/webhooks/github/{projectId}</p>
              </div>
              <div className="rounded-lg border border-white/[0.07] bg-black/40 backdrop-blur-xl p-3 font-mono text-xs break-all">
                <p className="text-foreground-400 mb-1">Secret:</p>
                <p className="cursor-pointer" onClick={(e) => { const el = e.currentTarget; if (el.textContent?.includes("•")) el.textContent = project.webhook_secret; else el.textContent = "••••••••••••••••••••"; }} title="Click to reveal">{"••••••••••••••••••••"}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-danger/30">
            <CardHeader><CardTitle className="text-danger">Danger Zone</CardTitle><CardDescription>Remove this app from the project</CardDescription></CardHeader>
            <CardContent>
              <p className="text-xs text-foreground-500 mb-3">This will stop the running process, remove source files, and reset the app configuration. The project and other services will remain.</p>
              <Button variant="danger" onPress={async () => {
                if (!confirm("Delete this app? Process, files, Docker images and deployments will be removed.")) return;
                try {
                  const res = await fetch(`/api/projects/${projectId}/app`, { method: "DELETE" });
                  if (res.ok) { toast.success("App removed"); router.push("/home"); }
                  else { const d = await res.json(); toast.error(d.error || "Failed"); }
                } catch { toast.error("Failed to remove app"); }
              }}><Icon icon="solar:trash-bin-trash-bold-duotone" width={18} />Delete App</Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ═══ File Manager ═══ */}
      <FileManager projectId={projectId} runtimeType={project.runtime_type} />

      {/* ═══ Project Settings Modal ═══ */}
      {showProjectSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowProjectSettings(false)} />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/[0.07] bg-[#12102a] p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold">Project Settings</h2>
              <button onClick={() => setShowProjectSettings(false)} className="text-foreground-400 hover:text-foreground transition-colors">
                <Icon icon="solar:close-circle-bold-duotone" width={22} />
              </button>
            </div>

            <div className="space-y-4">
              <TextField value={settName} onChange={setSettName}><Label>Project Name</Label><Input /></TextField>
              <Button variant="primary" className="w-full" isDisabled={settSaving} onPress={async () => {
                setSettSaving(true);
                try {
                  const res = await fetch(`/api/projects/${projectId}`, { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ name: settName.trim() }) });
                  if (res.ok) { toast.success("Project renamed"); const u = await res.json(); setProject((p) => p ? { ...p, name: u.name } : p); setShowProjectSettings(false); }
                  else { const d = await res.json(); toast.error(d.error || "Failed"); }
                } catch { toast.error("Failed"); }
                finally { setSettSaving(false); }
              }}>{settSaving ? <Spinner /> : "Save"}</Button>
            </div>

            <div className="mt-8 pt-6 border-t border-white/[0.07]">
              <p className="text-sm font-semibold text-danger mb-2">Danger Zone</p>
              <p className="text-xs text-foreground-500 mb-4">Deleting this project will stop all running processes, remove all services, and delete all data permanently.</p>
              <Button variant="danger" className="w-full" isDisabled={settDeleting} onPress={() => {
                if (!confirm("Delete this project and ALL its services? This cannot be undone.")) return;
                handleDelete();
              }}>{settDeleting ? <Spinner /> : <><Icon icon="solar:trash-bin-trash-bold-duotone" width={18} />Delete Project & All Services</>}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Deployment Card (inline component) ──

function DeploymentCard({ deployment: d }: { deployment: Deployment }) {
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function loadBuildLog() {
    if (buildLog !== null) { setExpanded(!expanded); return; }
    setLogLoading(true);
    try { const res = await fetch(`/api/deployments/${d.id}`); if (res.ok) { const data = await res.json(); setBuildLog(data.build_log || "(no log)"); setExpanded(true); } } catch {}
    setLogLoading(false);
  }

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="pt-0.5"><StatusBadge status={d.status} /></div>
            <div className="min-w-0">
              <p className="text-sm font-medium">{d.commit_message || `${d.trigger_type} deploy`}</p>
              <p className="text-xs text-foreground-400 mt-0.5">{d.commit_sha ? `${d.commit_sha.slice(0,7)} · ` : ""}{new Date(d.started_at).toLocaleString()}{d.finished_at && ` · ${fmtDuration(d.started_at, d.finished_at)}`}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" isIconOnly onPress={loadBuildLog}>{logLoading ? <Spinner /> : <Icon icon={expanded ? "solar:alt-arrow-up-bold" : "solar:document-text-bold-duotone"} width={16} />}</Button>
        </div>
        {d.error_message && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2"><p className="text-sm text-danger">{d.error_message}</p></div>}
        {expanded && buildLog && <div className="mt-3 max-h-96 overflow-auto rounded-lg border border-white/[0.07] bg-black/50 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-3"><pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground-400">{buildLog}</pre></div>}
      </CardContent>
    </Card>
  );
}

// ── File Manager ──

interface FileEntry { name: string; type: "file" | "dir"; size: number; }

function FileManager({ projectId, runtimeType }: { projectId: string; runtimeType: string }) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);

  const [dirError, setDirError] = useState<string | null>(null);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoadingDir(true);
    setDirError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(dirPath)}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries || []);
        setCurrentPath(dirPath);
      } else {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setDirError(data.error || `Failed (${res.status})`);
        setEntries([]);
      }
    } catch (err) {
      setDirError(err instanceof Error ? err.message : "Failed to load files");
      setEntries([]);
    }
    finally { setLoadingDir(false); }
  }, [projectId]);

  useEffect(() => { loadDir("/"); }, [loadDir]);

  async function openFile(filePath: string) {
    setLoadingFile(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content);
        setOriginalContent(data.content);
        setSelectedFile(filePath);
      } else {
        const data = await res.json();
        toast.error(data.error || "Cannot open file");
      }
    } catch { toast.error("Failed to open file"); }
    finally { setLoadingFile(false); }
  }

  async function saveFile() {
    if (!selectedFile) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      if (res.ok) { toast.success("File saved"); setOriginalContent(fileContent); }
      else { const data = await res.json(); toast.error(data.error || "Save failed"); }
    } catch { toast.error("Save failed"); }
    finally { setSaving(false); }
  }

  function navigateUp() {
    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
    loadDir(parent);
  }

  function navigateTo(entry: FileEntry) {
    if (entry.type === "dir") {
      const newPath = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      loadDir(newPath);
    } else {
      const filePath = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      openFile(filePath);
    }
  }

  const breadcrumbs = currentPath.split("/").filter(Boolean);
  const hasChanges = fileContent !== originalContent;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Icon icon="solar:folder-bold-duotone" className="text-purple-400" width={18} />
        <p className="text-sm font-semibold">Files</p>
        {runtimeType === "docker" && <span className="text-[10px] text-foreground-500 bg-white/[0.05] px-2 py-0.5 rounded-full">container</span>}
      </div>

      <div className={`flex flex-col sm:flex-row rounded-xl border border-white/[0.07] overflow-hidden resize-y ${selectedFile ? "min-h-[400px] sm:min-h-[300px] h-[500px] sm:h-[450px]" : "min-h-[200px] h-[300px]"} max-h-[80vh]`}>
        {/* File Tree */}
        <div className={`flex flex-col border-b sm:border-b-0 sm:border-r border-white/[0.07] bg-black/30 overflow-auto ${selectedFile ? "h-[150px] sm:h-auto w-full sm:w-[250px] flex-shrink-0" : "flex-1"}`}>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-white/[0.05] text-xs text-foreground-500 flex-shrink-0">
            <button onClick={() => loadDir("/")} className="hover:text-foreground-300 transition-colors">/</button>
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                <span>/</span>
                <button onClick={() => loadDir("/" + breadcrumbs.slice(0, i + 1).join("/"))} className="hover:text-foreground-300 transition-colors">{crumb}</button>
              </span>
            ))}
          </div>

          {/* Back button */}
          {currentPath !== "/" && (
            <button onClick={navigateUp} className="flex items-center gap-2 px-3 py-1.5 text-xs text-foreground-400 hover:bg-white/[0.03] transition-colors">
              <Icon icon="solar:arrow-left-linear" width={12} />
              ..
            </button>
          )}

          {/* Entries */}
          {loadingDir ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : dirError ? (
            <p className="text-xs text-danger text-center py-8">{dirError}</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-foreground-500 text-center py-8">Empty directory</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.name}
                onClick={() => navigateTo(entry)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/[0.03] transition-colors text-left w-full ${
                  selectedFile && entry.type === "file" && (currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`) === selectedFile
                    ? "bg-purple-500/10 text-purple-300"
                    : "text-foreground-300"
                }`}
              >
                <Icon
                  icon={entry.type === "dir" ? "solar:folder-bold-duotone" : "solar:document-bold-duotone"}
                  className={entry.type === "dir" ? "text-purple-400" : "text-foreground-500"}
                  width={14}
                />
                <span className="truncate flex-1">{entry.name}</span>
                {entry.type === "file" && entry.size > 0 && (
                  <span className="text-[10px] text-foreground-500 flex-shrink-0">{entry.size > 1024 ? `${(entry.size / 1024).toFixed(0)}K` : `${entry.size}B`}</span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Editor */}
        {selectedFile && (
          <div className="flex-1 flex flex-col bg-black/20">
            {/* Editor header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05] flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Icon icon="solar:document-bold-duotone" className="text-foreground-500" width={14} />
                <span className="text-xs text-foreground-400 truncate">{selectedFile}</span>
                {hasChanges && <span className="text-[10px] text-amber-400">modified</span>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="ghost" size="sm" onPress={() => { setSelectedFile(null); setFileContent(""); }}>
                  <Icon icon="solar:close-circle-bold-duotone" width={16} />
                </Button>
                <Button variant="primary" size="sm" isDisabled={saving || !hasChanges} onPress={saveFile}>
                  {saving ? <Spinner /> : "Save"}
                </Button>
              </div>
            </div>

            {/* Editor content */}
            {loadingFile ? (
              <div className="flex justify-center items-center flex-1"><Spinner /></div>
            ) : (
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                className="flex-1 w-full resize-none bg-transparent p-4 font-mono text-xs text-foreground-300 outline-none leading-5"
                spellCheck={false}
                onKeyDown={(e) => {
                  // Ctrl+S to save
                  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                    e.preventDefault();
                    if (hasChanges) saveFile();
                  }
                  // Tab to indent
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const start = e.currentTarget.selectionStart;
                    const end = e.currentTarget.selectionEnd;
                    setFileContent(fileContent.substring(0, start) + "  " + fileContent.substring(end));
                    setTimeout(() => { e.currentTarget.selectionStart = e.currentTarget.selectionEnd = start + 2; }, 0);
                  }
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
