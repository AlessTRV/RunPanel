"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { PortHint, ServiceLinkHint } from "@/components/DeployHints";
import { cn } from "@/lib/utils";

type SourceType = "github" | "upload";
type RuntimeType = "node" | "docker" | "compose" | "custom";

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  private: boolean;
  updated_at: string;
}

function relativeTime(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return "";
  if (days <= 0) return "oggi";
  if (days === 1) return "ieri";
  if (days < 30) return `${days}g fa`;
  if (days < 365) return `${Math.floor(days / 30)}m fa`;
  return `${Math.floor(days / 365)}a fa`;
}

const RUNTIMES: { id: RuntimeType; label: string; hint: string; icon: string }[] = [
  { id: "node", label: "Node.js", hint: "Rileva il package manager e lo script di build", icon: "solar:code-linear" },
  { id: "docker", label: "Docker", hint: "Costruisce il Dockerfile del repository", icon: "solar:box-linear" },
  { id: "compose", label: "Compose", hint: "Avvia lo stack descritto dal compose file", icon: "solar:layers-linear" },
  { id: "custom", label: "Custom", hint: "Comandi espliciti, qualsiasi linguaggio", icon: "solar:command-linear" },
];

/**
 * What each runtime expects to find in the checkout. Said here rather than
 * discovered ten minutes later, at the bottom of a failed build log.
 */
const RUNTIME_REQUIREMENTS: Record<RuntimeType, React.ReactNode> = {
  node: (
    <>
      Serve un <Code>package.json</Code> nella root. Il lockfile decide il package manager
      (<Code>bun.lock</Code>, <Code>pnpm-lock.yaml</Code>, <Code>yarn.lock</Code>, altrimenti npm) e
      lo script <Code>build</Code> viene eseguito se esiste.
    </>
  ),
  docker: (
    <>
      Serve un <Code>Dockerfile</Code> nella root del repository: viene costruito con il contesto
      sulla root. Le variabili di build arrivano come <Code>--build-arg</Code>, quindi vanno
      dichiarate anche con <Code>ARG</Code> nel Dockerfile per essere visibili.
    </>
  ),
  compose: (
    <>
      Serve un <Code>compose.yaml</Code>, <Code>compose.yml</Code>,{" "}
      <Code>docker-compose.yaml</Code> o <Code>docker-compose.yml</Code> nella root. Lo stack viene
      avviato con un nome di progetto derivato dallo slug, così i container restano riconoscibili.
    </>
  ),
  custom: (
    <>
      Nessun rilevamento: quello che scrivi qui sotto è tutto quello che viene eseguito. Il comando
      di avvio è obbligatorio e deve restare in primo piano — un comando che va in background
      sembra un&apos;app morta un secondo dopo il deploy.
    </>
  ),
};

export function AppForm({
  projectId,
  submitLabel = "Configura app",
  secondaryAction,
}: {
  projectId: string;
  submitLabel?: string;
  /** Rendered beside the submit button — e.g. "configure later" during creation. */
  secondaryAction?: ReactNode;
}) {
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
  const [selectedRepo, setSelectedRepo] = useState<GhRepo | null>(null);
  const [manualUrl, setManualUrl] = useState(false);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const { data: repoData, loading: reposLoading } = useResource<{
    connected?: boolean;
    repos?: GhRepo[];
  }>("/api/github/repos");

  const connected = repoData?.connected ?? false;
  const repos = repoData?.repos ?? [];

  const query = repoSearch.trim().toLowerCase();
  const filteredRepos = query
    ? repos.filter((r) => r.full_name.toLowerCase().includes(query))
    : repos;

  // Branches are fetched only once a repository is picked; a null url keeps the
  // hook idle until then.
  const { data: branchData, loading: branchesLoading } = useResource<{ branches?: { name: string }[] }>(
    selectedRepo ? `/api/github/branches?repo=${encodeURIComponent(selectedRepo.full_name)}` : null
  );
  const branches = branchData?.branches ?? [];

  function pickRepo(repo: GhRepo) {
    setSelectedRepo(repo);
    setSourceUrl(repo.clone_url);
    setBranch(repo.default_branch);
    setManualUrl(false);
  }

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
            {selectedRepo ? (
              <div className="border-border bg-surface-secondary flex items-center gap-3 rounded-[var(--radius)] border px-3 py-2.5">
                <Icon icon="solar:folder-with-files-linear" width={18} className="text-accent shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm">{selectedRepo.full_name}</p>
                  {selectedRepo.description && (
                    <p className="text-muted truncate text-xs">{selectedRepo.description}</p>
                  )}
                </div>
                {selectedRepo.private && (
                  <Icon icon="solar:lock-linear" width={14} className="text-muted shrink-0" aria-label="privato" />
                )}
                <button
                  type="button"
                  onClick={() => setSelectedRepo(null)}
                  className="text-muted hover:text-foreground shrink-0 text-sm transition-colors"
                >
                  Cambia
                </button>
              </div>
            ) : connected ? (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-muted text-sm font-medium">
                    I tuoi repository{repos.length > 0 ? ` (${filteredRepos.length})` : ""}
                  </span>
                  <Input
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    placeholder="Cerca…"
                    aria-label="Cerca repository"
                    className="max-w-[180px]"
                  />
                </div>

                {reposLoading ? (
                  <p className="text-muted px-3 py-6 text-center text-sm">Carico i repository…</p>
                ) : filteredRepos.length === 0 ? (
                  <p className="text-muted px-3 py-6 text-center text-sm">
                    {repos.length === 0 ? "Nessun repository accessibile" : "Nessun risultato"}
                  </p>
                ) : (
                  <ul className="border-border max-h-72 divide-y divide-[var(--border)] overflow-auto rounded-[var(--radius)] border">
                    {filteredRepos.map((repo) => (
                      <li key={repo.id}>
                        <button
                          type="button"
                          onClick={() => pickRepo(repo)}
                          className="hover:bg-surface-hover flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="text-foreground block truncate text-sm">{repo.full_name}</span>
                            {repo.description && (
                              <span className="text-muted block truncate text-xs">{repo.description}</span>
                            )}
                          </span>
                          {repo.private && (
                            <Icon icon="solar:lock-linear" width={13} className="text-muted shrink-0" aria-label="privato" />
                          )}
                          {repo.language && (
                            <span className="text-muted shrink-0 font-mono text-[11px]">{repo.language}</span>
                          )}
                          <span className="text-muted shrink-0 text-[11px] tabular-nums">
                            {relativeTime(repo.updated_at)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  type="button"
                  onClick={() => setManualUrl((v) => !v)}
                  className="text-muted hover:text-foreground mt-2 text-xs transition-colors"
                >
                  {manualUrl ? "Nascondi" : "Oppure incolla un URL"}
                </button>
              </div>
            ) : (
              <div className="border-border rounded-[var(--radius)] border border-dashed px-3 py-4">
                <p className="text-foreground text-sm">Nessun account GitHub collegato</p>
                <p className="text-muted mt-1 text-xs">
                  Collega un token per scegliere da un elenco e per clonare i repository privati.{" "}
                  <Link href="/github" className="text-accent hover:underline">
                    Collega ora
                  </Link>
                </p>
              </div>
            )}

            {(manualUrl || (!connected && !selectedRepo)) && (
              <TextField value={sourceUrl} onChange={setSourceUrl}>
                <Label>URL del repository</Label>
                <Input placeholder="https://github.com/utente/repo.git" className="font-mono text-sm" />
              </TextField>
            )}

            {/* A native select rather than a listbox: the branch list is plain
                data, and this is keyboard- and screen-reader-correct for free. */}
            {selectedRepo && branches.length > 0 ? (
              <div>
                <label htmlFor="branch-select" className="text-muted mb-1 block text-sm font-medium">
                  Branch
                </label>
                <select
                  id="branch-select"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="border-border bg-background text-foreground focus:border-accent/60 w-full rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
                >
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                      {b.name === selectedRepo.default_branch ? "  (default)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <TextField value={branch} onChange={setBranch}>
                <Label>Branch</Label>
                <Input
                  className="font-mono text-sm"
                  placeholder={branchesLoading ? "Carico i branch…" : "main"}
                />
              </TextField>
            )}

            <FieldHint>
              È il branch che viene clonato a ogni deploy. Con l&apos;auto-deploy attivo, un push su
              un altro branch viene ricevuto e ignorato: solo questo fa partire un deploy.
            </FieldHint>
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
            <FieldHint>
              Massimo 100 MB. Se l&apos;archivio contiene una sola cartella al primo livello viene
              aperta da sola, quindi <Code>progetto.zip → progetto/package.json</Code> va bene
              quanto averlo in cima. Ogni upload sostituisce i file precedenti del progetto, e
              senza repository collegato non c&apos;è auto-deploy: ricarichi lo ZIP a ogni
              modifica.
            </FieldHint>
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

        <Hint>{RUNTIME_REQUIREMENTS[runtime]}</Hint>

        <div>
          <TextField value={port} onChange={setPort}>
            <Label>Porta</Label>
            <Input type="number" placeholder="3000" />
          </TextField>
          <PortHint runtimeType={runtime} />
        </div>

        {runtime !== "docker" && runtime !== "compose" && (
          <div className="border-border space-y-3 border-t pt-4">
            <p className="text-muted text-xs">
              Un comando per riga, eseguiti in ordine nella stessa shell. Lasciando vuoto, RunPanel
              prova a dedurli dal repository — per un progetto Node.js quasi sempre ci riesce.
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

      <ServiceLinkHint projectId={projectId} />

      <div className="flex items-center justify-end gap-3">
        {secondaryAction}
        <Button variant="primary" isPending={saving} onPress={create}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
