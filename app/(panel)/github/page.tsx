"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input, Label, SearchField, Spinner, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { DangerZone } from "@/components/ui/DangerAction";
import { FieldHint } from "@/components/ui/Hint";
import { formatRelative } from "@/lib/format";

/**
 * The GitHub connection, and the repositories it can see.
 *
 * A pre-refactor leftover: raw HeroUI Cards where every other screen uses
 * `Panel`, English copy in an Italian panel, a hand-written "No repositories
 * found" instead of the shared `EmptyState`, an icon-only refresh button with
 * no accessible name, and a bare `Input` whose only label was a placeholder —
 * which disappears the moment you type into it.
 */

interface Repo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  description: string | null;
  language: string | null;
  default_branch: string;
  private: boolean;
  updated_at: string;
}

export default function GitHubPage() {
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [search, setSearch] = useState("");

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/github/repos");
      const data = await res.json();
      if (data.repos) setRepos(data.repos);
      else if (data.error) toast.error(data.error);
    } catch {
      toast.error("Impossibile leggere i repository");
    } finally {
      setLoadingRepos(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.github_token === "configured") {
          setHasToken(true);
          void loadRepos();
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [loadRepos]);

  async function saveToken() {
    if (!token.trim()) {
      toast.error("Incolla il token");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_token: token.trim() }),
      });
      if (res.ok) {
        toast.success("GitHub collegato");
        setHasToken(true);
        setToken("");
        void loadRepos();
      } else {
        const d = await res.json();
        toast.error(d.error || "Collegamento non riuscito");
      }
    } catch {
      toast.error("Collegamento non riuscito");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ github_token: "" }),
    });
    setHasToken(false);
    setRepos([]);
    toast.success("GitHub scollegato");
  }

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? repos.filter(
        (r) => r.name.toLowerCase().includes(needle) || r.full_name.toLowerCase().includes(needle)
      )
    : repos;

  return (
    <>
      <PageHeader title="GitHub" description="Repository privati e branch reali nel wizard" />

      <div className="max-w-2xl space-y-4">
        {hasToken ? (
          <>
            <Panel className="space-y-3">
              <PanelHeader
                title="Collegato"
                description="Il token è cifrato a riposo e non lascia mai il pannello"
              />
              <p className="text-muted flex items-center gap-2 text-sm">
                <span className="bg-success size-2 rounded-full" aria-hidden />
                RunPanel può leggere i tuoi repository e i loro branch.
              </p>
            </Panel>

            <Panel padding="flush">
              <div className="flex items-center gap-3 p-4 sm:p-5">
                <div className="min-w-0 flex-1">
                  <SearchField value={search} onChange={setSearch} aria-label="Cerca fra i repository">
                    <Label className="sr-only">Cerca</Label>
                    <Input placeholder="Cerca un repository" className="text-sm" />
                  </SearchField>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label="Ricarica l'elenco"
                  isDisabled={loadingRepos}
                  onPress={() => void loadRepos()}
                >
                  <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                </Button>
              </div>

              {loadingRepos ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon="solar:code-linear"
                  title={needle ? "Nessuna corrispondenza" : "Nessun repository"}
                  description={
                    needle
                      ? "Nessun repository contiene questo testo nel nome."
                      : "Il token non vede nessun repository. Serve lo scope repo."
                  }
                />
              ) : (
                <ul className="divide-border divide-y">
                  {filtered.map((repo) => (
                    <li
                      key={repo.id}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground truncate text-sm">{repo.name}</span>
                          {repo.private && (
                            <span className="bg-surface-secondary text-muted text-meta rounded px-1.5 py-0.5">
                              privato
                            </span>
                          )}
                          {repo.language && (
                            <span className="text-muted text-meta">{repo.language}</span>
                          )}
                        </div>
                        {repo.description && (
                          <p className="text-muted mt-0.5 truncate text-xs">{repo.description}</p>
                        )}
                      </div>
                      <div className="text-muted text-meta shrink-0 text-right">
                        <p className="font-mono">{repo.default_branch}</p>
                        <p>{formatRelative(repo.updated_at)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <DangerZone
              title="Scollega GitHub"
              description="Il token viene cancellato dal pannello"
              actionLabel="Scollega"
              confirm={{
                title: "Scollegare GitHub?",
                confirmLabel: "Scollega",
                description:
                  "I progetti già creati restano e continuano a distribuirsi. Smetterai di vedere i repository privati nel wizard, e i clone privati falliranno.",
              }}
              onConfirm={disconnect}
            />
          </>
        ) : (
          <Panel className="space-y-4">
            <PanelHeader
              title="Personal Access Token"
              description="Serve solo per i repository privati e per elencare i branch"
            />
            <div>
              <TextField type="password" value={token} onChange={setToken}>
                <Label>Token</Label>
                <Input placeholder="ghp_…" className="font-mono text-sm" />
              </TextField>
              <FieldHint>
                Su GitHub: Settings → Developer settings → Personal access tokens. Serve lo scope{" "}
                <strong className="text-foreground">repo</strong>. Viene cifrato a riposo e allegato
                solo alle richieste verso GitHub.
              </FieldHint>
            </div>
            <div>
              <Button variant="primary" isPending={saving} onPress={saveToken}>
                Collega
              </Button>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
