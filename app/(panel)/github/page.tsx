"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, TextField, Label, Input, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

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

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then(r => r.json())
      .then((data) => {
        if (data.github_token === "configured") {
          setHasToken(true);
          loadRepos();
        }
      }).catch(() => {});
    return () => controller.abort();
  }, []);

  async function loadRepos() {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/github/repos");
      const data = await res.json();
      if (data.repos) setRepos(data.repos);
      else if (data.error) toast.error(data.error);
    } catch { toast.error("Failed to load repos"); }
    finally { setLoadingRepos(false); }
  }

  async function handleSaveToken() {
    if (!token.trim()) { toast.error("Token is required"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ github_token: token.trim() }) });
      if (res.ok) {
        toast.success("Token saved");
        setHasToken(true);
        setToken("");
        loadRepos();
      } else { const d = await res.json(); toast.error(d.error || "Failed"); }
    } catch { toast.error("Failed"); }
    finally { setSaving(false); }
  }

  async function handleDisconnect() {
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ github_token: "" }) });
    setHasToken(false);
    setRepos([]);
    toast.success("GitHub disconnected");
  }

  const filtered = search ? repos.filter(r => r.name.toLowerCase().includes(search.toLowerCase()) || r.full_name.toLowerCase().includes(search.toLowerCase())) : repos;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">GitHub</h1>
        <p className="text-sm text-muted">Connect your GitHub account to browse repositories</p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Token Config */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:link-bold-duotone" width={24} className="text-accent" />
              <div>
                <CardTitle>Personal Access Token</CardTitle>
                <CardDescription>{hasToken ? "Connected — token is stored encrypted" : "Enter a GitHub PAT with repo scope"}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {hasToken ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-success" />
                  <span className="text-sm text-muted">GitHub connected</span>
                </div>
                <Button variant="danger" size="sm" onPress={handleDisconnect}>Disconnect</Button>
              </div>
            ) : (
              <>
                <TextField type="password" value={token} onChange={setToken}>
                  <Label>Token</Label>
                  <Input placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" className="font-mono text-sm" />
                </TextField>
                <Button variant="primary" isDisabled={saving} onPress={handleSaveToken}>{saving ? <Spinner /> : "Connect"}</Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* Repos */}
        {hasToken && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Repositories</h2>
              <Button variant="ghost" size="sm" onPress={loadRepos} isDisabled={loadingRepos}>
                <Icon icon="solar:refresh-bold-duotone" width={16} />
              </Button>
            </div>

            <div className="mb-3">
              <Input placeholder="Search repos..." value={search} onChange={(e) => setSearch(e.target.value)} className="text-sm" />
            </div>

            {loadingRepos ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted text-center py-8">No repositories found</p>
            ) : (
              <div className="space-y-2">
                {filtered.map((repo) => (
                  <div key={repo.id} className="flex items-center justify-between rounded-xl bg-surface px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold truncate">{repo.name}</p>
                        {repo.private && <span className="text-[10px] text-muted bg-surface-secondary px-1.5 py-0.5 rounded">private</span>}
                        {repo.language && <span className="text-[10px] text-muted">{repo.language}</span>}
                      </div>
                      {repo.description && <p className="text-xs text-muted truncate mt-0.5">{repo.description}</p>}
                    </div>
                    <p className="text-[11px] text-muted flex-shrink-0 ml-3">{repo.default_branch}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
