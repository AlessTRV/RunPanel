"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
}

/**
 * Browse and edit the project's files.
 *
 * Mounted only when its tab is open. It used to render unconditionally at the
 * bottom of the page, so every log line and every status poll re-rendered a
 * file tree and a textarea holding an entire file — for users who were not even
 * looking at it.
 */
export function FileManager({ projectId, runtimeType }: { projectId: string; runtimeType: string }) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [dirError, setDirError] = useState<string | null>(null);
  const [loadingDir, setLoadingDir] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadDir = useCallback(
    (dirPath: string, signal?: AbortSignal) =>
      fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(dirPath)}`, { signal })
        .then(async (res) => {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          return data as { entries?: FileEntry[] };
        })
        .then((data) => {
          setEntries(data.entries ?? []);
          setCurrentPath(dirPath);
          setDirError(null);
          setLoadingDir(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setDirError(err instanceof Error ? err.message : "Lettura non riuscita");
          setEntries([]);
          setLoadingDir(false);
        }),
    [projectId]
  );

  useEffect(() => {
    const controller = new AbortController();
    // State is set from the promise callbacks, never synchronously here.
    loadDir("/", controller.signal);
    return () => controller.abort();
  }, [loadDir]);

  function open(entry: FileEntry) {
    const full = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;

    if (entry.type === "dir") {
      setLoadingDir(true);
      void loadDir(full);
      return;
    }

    setLoadingFile(true);
    void fetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(full)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Impossibile aprire il file");
        setContent(data.content);
        setOriginalContent(data.content);
        setSelectedFile(full);
        setLoadingFile(false);
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Impossibile aprire il file");
        setLoadingFile(false);
      });
  }

  async function save() {
    if (!selectedFile) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, content }),
      });
      if (res.ok) {
        toast.success("File salvato");
        setOriginalContent(content);
      } else {
        const data = await res.json();
        toast.error(data.error ?? MSG.saveFailed);
      }
    } catch {
      toast.error(MSG.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const crumbs = currentPath.split("/").filter(Boolean);
  const dirty = content !== originalContent;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Icon icon="solar:folder-linear" className="text-muted" width={18} aria-hidden />
        <h2 className="text-foreground text-sm font-medium">File</h2>
        {runtimeType === "docker" && (
          <span className="bg-default text-muted rounded-full px-2 py-0.5 text-meta">
            container
          </span>
        )}
      </div>

      <div
        className={cn(
          "border-border flex flex-col overflow-hidden rounded-[var(--radius)] border sm:flex-row",
          selectedFile ? "h-[520px]" : "h-[320px]"
        )}
      >
        <div
          className={cn(
            "border-border bg-background flex flex-col overflow-auto border-b sm:border-r sm:border-b-0",
            selectedFile ? "h-[200px] w-full shrink-0 sm:h-auto sm:w-[260px]" : "flex-1"
          )}
        >
          <nav
            aria-label="Percorso dei file"
            className="border-border text-muted flex shrink-0 items-center gap-1 border-b px-3 py-2 text-xs"
          >
            <button onClick={() => { setLoadingDir(true); void loadDir("/"); }} className="hover:text-foreground">
              /
            </button>
            {crumbs.map((crumb, i) => (
              <span key={`${crumb}-${i}`} className="flex items-center gap-1">
                <span aria-hidden>/</span>
                <button
                  onClick={() => { setLoadingDir(true); void loadDir(`/${crumbs.slice(0, i + 1).join("/")}`); }}
                  className="hover:text-foreground truncate"
                >
                  {crumb}
                </button>
              </span>
            ))}
          </nav>

          {currentPath !== "/" && (
            <button
              onClick={() => {
                setLoadingDir(true);
                void loadDir(currentPath.split("/").slice(0, -1).join("/") || "/");
              }}
              className="text-muted hover:bg-surface-hover flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <Icon icon="solar:arrow-left-linear" width={12} aria-hidden />
              ..
            </button>
          )}

          {loadingDir ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : dirError ? (
            <p className="text-danger px-3 py-8 text-center text-xs">{dirError}</p>
          ) : entries.length === 0 ? (
            <p className="text-muted py-8 text-center text-xs">Cartella vuota</p>
          ) : (
            entries.map((entry) => {
              const full = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
              const active = selectedFile === full;
              return (
                <button
                  key={entry.name}
                  onClick={() => open(entry)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                    // Quiet: the tree is an arbitrarily long scrolling list of
                    // tightly packed rows, and a halo there reads as a smudge.
                    active ? "selected-quiet text-accent" : "text-muted hover:bg-surface-hover"
                  )}
                >
                  <Icon
                    icon={entry.type === "dir" ? "solar:folder-linear" : "solar:document-linear"}
                    width={14}
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{entry.name}</span>
                  {entry.type === "file" && entry.size > 0 && (
                    <span className="text-muted text-meta shrink-0">{formatBytes(entry.size)}</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {selectedFile && (
          <div className="bg-background flex flex-1 flex-col">
            <div className="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Icon icon="solar:document-linear" className="text-muted" width={14} aria-hidden />
                <span className="text-muted truncate font-mono text-xs">{selectedFile}</span>
                {dirty && <span className="text-warning text-meta">modificato</span>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label="Chiudi il file"
                  onPress={() => { setSelectedFile(null); setContent(""); setOriginalContent(""); }}
                >
                  <Icon icon="solar:close-circle-linear" width={16} />
                </Button>
                <Button variant="primary" size="sm" isPending={saving} isDisabled={!dirty} onPress={save}>
                  Salva
                </Button>
              </div>
            </div>

            {loadingFile ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                aria-label={`Contenuto di ${selectedFile}`}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                    e.preventDefault();
                    void save();
                  }
                }}
                className="text-foreground flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
