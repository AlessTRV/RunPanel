"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
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
  const projectId = params.projectId as string;

  const [project, setProject] = useState<Project | null>(null);
  const [processInfo, setProcessInfo] = useState<ProcessInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("logs");

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
  const [termMode, setTermMode] = useState<"logs" | "shell">("logs");
  const [shellActive, setShellActive] = useState(false);
  const [shellStarting, setShellStarting] = useState(false);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [termInput, setTermInput] = useState("");
  const termRef = useRef<HTMLDivElement>(null);
  const termPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const termSeenRef = useRef(new Set<string>());

  // Settings state
  const [settName, setSettName] = useState("");
  const [settBranch, setSettBranch] = useState("");
  const [settPort, setSettPort] = useState("");
  const [settPm, setSettPm] = useState<"auto"|"npm"|"bun"|"pnpm"|"yarn">("auto");
  const [settSaving, setSettSaving] = useState(false);
  const [settDeleting, setSettDeleting] = useState(false);

  // ── Load project ──
  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((p) => {
        setProject(p);
        setSettName(p.name); setSettBranch(p.source_branch); setSettPort(p.port?.toString() || "");
        try { const bc = JSON.parse(p.builder_config || "{}"); setSettPm(bc.packageManager || "auto"); } catch {}
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
    const interval = setInterval(async () => {
      const [pr, st] = await Promise.all([
        fetch(`/api/projects/${projectId}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/projects/${projectId}/status`).then(r => r.ok ? r.json() : null),
      ]);
      if (pr) {
        const prev = prevStatusRef.current;
        prevStatusRef.current = pr.status;
        setProject(pr);
        if (prev === "deploying" && pr.status === "running") toast.success("Deploy completed");
        if (prev === "deploying" && pr.status === "error") toast.error("Deploy failed");
      }
      if (st?.process) setProcessInfo(st.process);
    }, 3000);
    return () => clearInterval(interval);
  }, [projectId]);

  // ── Logs polling ──
  const pollLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/logs?source=process`);
      if (!res.ok) return;
      const data = await res.json();
      for (const l of (data.logs as string[] || [])) {
        if (!seenLogsRef.current.has(l)) { seenLogsRef.current.add(l); setLogs(p => [...p, l]); }
      }
    } catch {}
  }, [projectId]);

  useEffect(() => {
    if (activeTab !== "logs") return;
    seenLogsRef.current.clear(); setLogs([]);
    pollLogs();
    const i = setInterval(pollLogs, 2000);
    return () => clearInterval(i);
  }, [activeTab, pollLogs]);

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
      .then(r => r.json())
      .then((data) => setEnvVars(data.map((v: {key:string;value:string}) => ({key:v.key,value:v.value}))))
      .finally(() => setEnvLoading(false));
  }, [activeTab, projectId]);

  // ── Terminal polling ──
  const pollTermLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/logs?source=process`);
      if (!res.ok) return;
      const data = await res.json();
      for (const l of (data.logs as string[] || [])) {
        if (!termSeenRef.current.has(l)) { termSeenRef.current.add(l); setTermLines(p => [...p, l + "\n"]); }
      }
    } catch {}
  }, [projectId]);

  useEffect(() => {
    if (activeTab !== "terminal") return;
    if (termPollRef.current) clearInterval(termPollRef.current);
    if (termMode === "logs") {
      termSeenRef.current.clear(); setTermLines([]);
      pollTermLogs();
      termPollRef.current = setInterval(pollTermLogs, 2000);
    } else if (termMode === "shell" && shellActive) {
      termPollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/projects/${projectId}/terminal`);
          const data = await res.json();
          if (data.output) setTermLines(p => [...p, data.output]);
          if (!data.active) setShellActive(false);
        } catch {}
      }, 300);
    }
    return () => { if (termPollRef.current) clearInterval(termPollRef.current); };
  }, [activeTab, termMode, shellActive, pollTermLogs, projectId]);

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
    setEnvSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/env`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({vars:valid}) });
      if (res.ok) { toast.success("Variables saved"); setEnvVars(valid); } else { const d = await res.json(); toast.error(d.error || "Failed"); }
    } catch { toast.error("Failed"); }
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
      const res = await fetch(`/api/projects/${projectId}`, { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ name: settName.trim(), sourceBranch: settBranch, port: settPort ? parseInt(settPort) : null, builderConfig: { packageManager: settPm !== "auto" ? settPm : undefined } }) });
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
    { id: "terminal", label: "Terminal", icon: "solar:monitor-bold-duotone" },
    { id: "settings", label: "Settings", icon: "solar:settings-bold-duotone" },
  ];

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex items-center gap-4">
        <Button variant="ghost" size="sm" onPress={() => router.push("/home")}><Icon icon="solar:arrow-left-linear" width={18} /></Button>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/15"><Icon icon="solar:box-bold-duotone" className="text-purple-400" width={22} /></div>
        <div className="flex-1">
          <div className="flex items-center gap-2"><h1 className="text-xl font-bold">{project.name}</h1><StatusBadge status={project.status} /></div>
          <p className="text-xs text-foreground-400">{project.runtime_type} · :{project.port || "auto"} · {project.source_branch}</p>
        </div>
      </div>

      {/* Control Bar */}
      <div className="mb-4 flex gap-2 flex-wrap">
        <Button variant="primary" size="sm" isDisabled={deploying || project.status === "deploying"} onPress={() => handleDeploy("deploy")}>{deploying ? <Spinner /> : <Icon icon="solar:upload-bold-duotone" width={16} />}Deploy</Button>
        <Button variant="outline" size="sm" isDisabled={deploying || project.status === "deploying"} onPress={() => handleDeploy("rebuild")}><Icon icon="solar:refresh-circle-bold-duotone" width={16} />Re-Build</Button>
        {(project.status === "running" || project.status === "error") && (<><Button variant="outline" size="sm" onPress={() => handleControl("restart")}><Icon icon="solar:refresh-bold-duotone" width={16} />Restart</Button><Button variant="danger" size="sm" onPress={() => handleControl("stop")}><Icon icon="solar:stop-bold-duotone" width={16} />Stop</Button></>)}
        {(project.status === "stopped" || project.status === "error") && (<Button variant="secondary" size="sm" onPress={() => handleControl("start")}><Icon icon="solar:play-bold-duotone" width={16} />Start</Button>)}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 mb-5 lg:grid-cols-4">
        <Card><CardContent className="p-4"><div className="flex items-center justify-between mb-2"><p className="text-sm font-medium text-foreground-400">Status</p><div className={`flex h-8 w-8 items-center justify-center rounded-lg ${processInfo?.running ? "bg-emerald-500/15" : "bg-white/10"}`}><Icon icon="solar:shield-check-bold-duotone" className={processInfo?.running ? "text-emerald-400" : "text-foreground-400"} width={18} /></div></div><p className="text-2xl font-bold">{processInfo?.running ? "Online" : "Offline"}</p>{processInfo?.pid && <p className="text-xs text-foreground-500 mt-1">PID {processInfo.pid}</p>}</CardContent></Card>
        <Card><CardContent className="p-4"><div className="flex items-center justify-between mb-2"><p className="text-sm font-medium text-foreground-400">Uptime</p><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/15"><Icon icon="solar:clock-circle-bold-duotone" className="text-purple-400" width={18} /></div></div><p className="text-2xl font-bold">{processInfo?.uptime ? fmtUptime(processInfo.uptime) : "—"}</p></CardContent></Card>
        <Card><CardContent className="p-4"><div className="flex items-center justify-between mb-2"><p className="text-sm font-medium text-foreground-400">Memory</p><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15"><Icon icon="solar:server-bold-duotone" className="text-violet-400" width={18} /></div></div><p className="text-2xl font-bold">{processInfo?.memory ? fmtBytes(processInfo.memory) : "—"}</p></CardContent></Card>
        <Card><CardContent className="p-4"><div className="flex items-center justify-between mb-2"><p className="text-sm font-medium text-foreground-400">CPU</p><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15"><Icon icon="solar:cpu-bold-duotone" className="text-amber-400" width={18} /></div></div><p className="text-2xl font-bold">{processInfo?.cpu != null ? `${processInfo.cpu}%` : "—"}</p></CardContent></Card>
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
        <div ref={logsRef} className="h-[400px] overflow-auto rounded-xl border border-white/[0.07] bg-black/50 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-4 font-mono text-xs text-green-400/80">
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

      {/* ═══ TAB: Terminal ═══ */}
      {activeTab === "terminal" && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Button variant={termMode === "logs" ? "primary" : "outline"} size="sm" onPress={() => { if (shellActive) stopShell(); termSeenRef.current.clear(); setTermLines([]); setTermMode("logs"); }}><Icon icon="solar:document-text-bold-duotone" width={16} />Process Logs</Button>
            <Button variant={termMode === "shell" ? "primary" : "outline"} size="sm" onPress={() => { termSeenRef.current.clear(); setTermLines([]); setTermMode("shell"); }}><Icon icon="solar:monitor-bold-duotone" width={16} />Shell</Button>
            {termMode === "shell" && !shellActive && <Button variant="primary" size="sm" isDisabled={shellStarting} onPress={startShell}>{shellStarting ? <Spinner /> : <Icon icon="solar:play-bold-duotone" width={16} />}Start</Button>}
            {termMode === "shell" && shellActive && <Button variant="danger" size="sm" onPress={stopShell}><Icon icon="solar:stop-bold-duotone" width={16} />Stop</Button>}
          </div>
          <div ref={termRef} className="h-[400px] overflow-auto rounded-xl border border-white/[0.07] bg-black/50 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-4 font-mono text-sm text-green-400/80">
            {termLines.length === 0 ? <p className="text-foreground-500">{termMode === "logs" ? "Waiting for process logs..." : 'Click "Start" to open a shell.'}</p> : termLines.map((l, i) => <span key={i} className="whitespace-pre-wrap break-all">{l}</span>)}
          </div>
          {termMode === "shell" && shellActive && (
            <div className="mt-2 flex gap-2">
              <span className="flex items-center font-mono text-sm text-green-400">$</span>
              <input type="text" value={termInput} onChange={e => setTermInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { const cmd = termInput; setTermInput(""); setTermLines(p => [...p, `$ ${cmd}\n`]); fetch(`/api/projects/${projectId}/terminal`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({input:cmd+"\n"})}); } }} placeholder="Type a command..." autoFocus className="flex-1 rounded-lg border border-white/[0.07] bg-black/50 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] px-3 py-2 font-mono text-sm text-green-400/80 outline-none focus:border-primary/50" />
            </div>
          )}
        </div>
      )}

      {/* ═══ TAB: Settings ═══ */}
      {activeTab === "settings" && (
        <div className="max-w-2xl space-y-6">
          <Card>
            <CardHeader><CardTitle>General</CardTitle><CardDescription>Basic project configuration</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <TextField value={settName} onChange={setSettName}><Label>Project Name</Label><Input /></TextField>
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
                <p>{project.webhook_secret}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-danger/30">
            <CardHeader><CardTitle className="text-danger">Danger Zone</CardTitle><CardDescription>Irreversible actions</CardDescription></CardHeader>
            <CardContent>
              <Button variant="danger" isDisabled={settDeleting} onPress={handleDelete}>{settDeleting ? <Spinner /> : <Icon icon="solar:trash-bin-trash-bold-duotone" width={18} />}Delete Project</Button>
            </CardContent>
          </Card>
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
