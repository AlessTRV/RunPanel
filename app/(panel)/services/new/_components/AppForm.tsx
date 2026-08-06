"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { cn } from "@/lib/utils";

type SourceType = "github" | "upload";
type RuntimeType = "node" | "docker" | "custom";

interface GhRepo {
  name: string;
  clone_url: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  private: boolean;
}

const RUNTIMES: { id: RuntimeType; label: string; hint: string; icon: string }[] = [
  { id: "node", label: "Node.js", hint: "Rileva il package manager e lo script di build", icon: "solar:code-linear" },
  { id: "docker", label: "Docker", hint: "Costruisce il Dockerfile del repository", icon: "solar:box-linear" },
  { id: "custom", label: "Custom", hint: "Comandi espliciti, qualsiasi linguaggio", icon: "solar:command-linear" },
];

export function AppForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [sourceUrl, setSourceUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [runtime, setRuntime] = useState<RuntimeType>("node");
  const [port, setPort] = useState("");
  const [installCmd, setInstallCmd] = useState("");
  const [buildCmd, setBuildCmd] = useState("");
  const [startCmd, setStartCmd] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const zipInputRef = useRef<HTMLInputElement>(null);

  // Loaded only if a GitHub token is configured; a 400 here just means "no
  // token", which is a normal state rather than an error worth reporting.
  const { data: repoData } = useResource<{ repos?: GhRepo[] }>("/api/github/repos");
  const repos = repoData?.repos ?? [];
  const filteredRepos = repoSearch
    ? repos.filter((r) => r.name.toLowerCase().includes(repoSearch.toLowerCase()))
    : repos.slice(0, 8);

  async function create() {
    if (sourceType === "github" && !sourceUrl.trim()) {
      toast.error("Serve l'URL del repository");
      return;
    }
    if (sourceType === "upload" && !zipFile) {
      toast.error("Serve un file ZIP");
      return;
    }
    if (runtime === "custom" && !startCmd.trim()) {
      toast.error("Il runtime custom richiede un comando di avvio");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          sourceUrl: sourceType === "github" ? sourceUrl.trim() : null,
          sourceBranch: branch || "main",
          runtimeType: runtime,
          port: port ? Number.parseInt(port, 10) : null,
          builderConfig: {
            version: 1,
            commands: {
              install: installCmd.trim() || undefined,
              build: buildCmd.trim() || undefined,
              start: startCmd.trim() || undefined,
            },
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Configurazione fallita");
        return;
      }

      if (sourceType === "upload" && zipFile) {
        const project = await res.json();
        const form = new FormData();
        form.append("file", zipFile);
        form.append("projectSlug", project.slug);
        const upload = await fetch("/api/upload", { method: "POST", body: form });
        if (!upload.ok) {
          const data = await upload.json();
          toast.error(data.error ?? "Upload fallito");
          return;
        }
      }

      toast.success("App configurata");
      router.push(`/projects/${projectId}`);
    } catch {
      toast.error("Configurazione fallita");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title="Sorgente" description="Da dove arriva il codice" />

        <div className="flex gap-2">
          {(["github", "upload"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={sourceType === s ? "primary" : "outline"}
              onPress={() => setSourceType(s)}
            >
              {s === "github" ? "GitHub" : "Upload ZIP"}
            </Button>
          ))}
        </div>

        {sourceType === "github" ? (
          <>
            <TextField value={sourceUrl} onChange={setSourceUrl}>
              <Label>URL del repository</Label>
              <Input placeholder="https://github.com/utente/repo.git" className="font-mono text-sm" />
            </TextField>

            {repos.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-muted text-sm font-medium">I tuoi repository</span>
                  <Input
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    placeholder="Cerca…"
                    aria-label="Cerca repository"
                    className="max-w-[180px]"
                  />
                </div>
                <ul className="border-border max-h-52 divide-y divide-[var(--border)] overflow-auto rounded-[var(--radius)] border">
                  {filteredRepos.map((repo) => (
                    <li key={repo.clone_url}>
                      <button
                        type="button"
                        onClick={() => {
                          setSourceUrl(repo.clone_url);
                          setBranch(repo.default_branch);
                        }}
                        className={cn(
                          "hover:bg-surface-hover flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                          sourceUrl === repo.clone_url && "bg-surface-secondary"
                        )}
                      >
                        <span className="text-foreground min-w-0 flex-1 truncate text-sm">{repo.name}</span>
                        {repo.private && (
                          <Icon icon="solar:lock-linear" width={13} className="text-muted shrink-0" aria-label="privato" />
                        )}
                        {repo.language && (
                          <span className="text-muted shrink-0 font-mono text-[11px]">{repo.language}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <TextField value={branch} onChange={setBranch}>
              <Label>Branch</Label>
              <Input className="font-mono text-sm" />
            </TextField>
          </>
        ) : (
          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Archivio ZIP</span>
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
            />
            <Button variant="outline" size="sm" onPress={() => zipInputRef.current?.click()}>
              <Icon icon="solar:upload-linear" width={16} aria-hidden />
              {zipFile ? zipFile.name : "Scegli un file"}
            </Button>
          </div>
        )}
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader title="Runtime" description="Come viene costruita e avviata" />

        <div className="grid gap-2 sm:grid-cols-3">
          {RUNTIMES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRuntime(r.id)}
              aria-pressed={runtime === r.id}
              className={cn(
                "rounded-[var(--radius)] border px-3 py-3 text-left transition-colors",
                runtime === r.id ? "border-accent bg-surface-secondary" : "border-border hover:bg-surface-hover"
              )}
            >
              <span className="text-foreground flex items-center gap-2 text-sm">
                <Icon icon={r.icon} width={16} className="text-muted" aria-hidden />
                {r.label}
              </span>
              <span className="text-muted mt-1 block text-[11px]">{r.hint}</span>
            </button>
          ))}
        </div>

        <TextField value={port} onChange={setPort}>
          <Label>Porta</Label>
          <Input type="number" placeholder="3000" />
        </TextField>

        {runtime !== "docker" && (
          <div className="border-border space-y-3 border-t pt-4">
            <p className="text-muted text-xs">
              Un comando per riga. Lasciando vuoto, RunPanel prova a dedurli dal repository.
            </p>
            {[
              { label: "Install", value: installCmd, set: setInstallCmd, ph: "npm ci" },
              { label: "Build", value: buildCmd, set: setBuildCmd, ph: "npm run build" },
              { label: "Start", value: startCmd, set: setStartCmd, ph: "npm start" },
            ].map((field) => (
              <div key={field.label}>
                <label className="text-muted mb-1 block text-sm font-medium">{field.label}</label>
                <textarea
                  value={field.value}
                  onChange={(e) => field.set(e.target.value)}
                  rows={field.label === "Start" ? 1 : 2}
                  placeholder={field.ph}
                  className="border-border bg-background text-foreground focus:border-accent/60 w-full resize-y rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
                />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="flex justify-end">
        <Button variant="primary" isPending={saving} onPress={create}>
          Configura app
        </Button>
      </div>
    </div>
  );
}
