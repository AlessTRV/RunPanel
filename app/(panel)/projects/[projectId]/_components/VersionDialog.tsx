"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { Field } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { LinkButton } from "@/components/ui/LinkButton";
import { useResource } from "@/lib/hooks/useResource";
import { isCommitSha } from "@/lib/git-ref";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CommitsResponse, Project } from "./types";

const PAGE_SIZE = 20;
const MAX_SIZE = 100;

/**
 * Picking the version to deploy.
 *
 * The list is the branch's timeline as GitHub reports it, and choosing a row is
 * choosing where the project stops: the deploy that follows pins it there, so
 * this is the one screen that has to say what a pin costs — auto-deploy goes
 * quiet, and a rollback of the code is not a rollback of the database.
 *
 * The branch stays local until Distribuisci is pressed. Patching the project on
 * the select's `onChange` would change what auto-deploy follows from inside a
 * dialog that can still be cancelled.
 */
export function VersionDialog({
  isOpen,
  onOpenChange,
  project,
  onDeployCommit,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  /** Persists the branch if it changed, then starts the deploy. */
  onDeployCommit: (commitSha: string, branch: string) => Promise<void>;
}) {
  const [branch, setBranch] = useState(project.source_branch);
  const [selected, setSelected] = useState<string | null>(null);
  const [size, setSize] = useState(PAGE_SIZE);
  const [manual, setManual] = useState("");

  // Gated on `isOpen`, not only on the project: this dialog is mounted by the
  // page whether or not it is showing, and a null url is how the shared hook
  // stays idle. Without it, opening any project page would spend a GitHub API
  // call on a list nobody asked to see.
  const { data: branchData } = useResource<{ branches: { name: string }[] }>(
    isOpen && project.repo ? `/api/github/branches?repo=${encodeURIComponent(project.repo)}` : null
  );
  const branches = branchData?.branches ?? [];

  // One URL and one state, widened rather than paged: accumulating pages would
  // mean an effect copying fetched data into a useState, which is what turns one
  // render into two. The cost is refetching the first N — five requests at most.
  const { data, error, loading, refresh } = useResource<CommitsResponse>(
    isOpen && project.repo
      ? `/api/projects/${project.id}/commits?branch=${encodeURIComponent(branch)}&perPage=${size}`
      : null
  );

  const commits = data?.commits ?? [];
  // A failed request must not fall through to "nessun commit su questo branch",
  // which would blame an empty branch for a panel that could not ask.
  const available = data?.available ?? (Boolean(project.repo) && !error);
  // The route writes the sentence for every case it can see. These two it
  // cannot: one never reaches it, the other never comes back from it.
  const unavailableMessage =
    data?.message ??
    (error
      ? "Non è stato possibile leggere l'elenco dei commit. Riprova, oppure incolla lo SHA qui sotto."
      : "Questo progetto non parte da un repository GitHub: non c'è una cronologia di commit da cui scegliere.");

  const manualClean = manual.trim().toLowerCase();
  const manualValid = manualClean.length > 0 && isCommitSha(manualClean);
  // A typed SHA wins over a highlighted row: it is the more deliberate of the
  // two, and it is the way out when the list cannot be loaded at all.
  const target = manualClean.length > 0 ? (manualValid ? manualClean : null) : selected;

  const goingBackwards = Boolean(target && commits.length > 0 && commits[0].sha !== target);
  const branchChanges = branch !== project.source_branch;

  return (
    <FormDialog
      wide
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Scegli la versione da distribuire"
      description="Il progetto verrà ricostruito dal commit che scegli e resterà fermo lì finché non lo sblocchi."
      submitLabel="Distribuisci"
      isSubmitDisabled={!target || project.status === "deploying"}
      onSubmit={() => (target ? onDeployCommit(target, branch) : Promise.resolve())}
    >
      <Field
        label="Branch"
        htmlFor="version-branch"
        hint="Cambiare branch qui cambia il branch del progetto: da qui in avanti sarà quello che l'auto-deploy segue."
      >
        {/* A native select rather than a listbox: the branch list is plain data,
            and this is keyboard- and screen-reader-correct for free. */}
        {branches.length > 0 ? (
          <select
            id="version-branch"
            value={branches.some((b) => b.name === branch) ? branch : ""}
            onChange={(e) => {
              setBranch(e.target.value);
              // The selection belonged to the old timeline.
              setSelected(null);
              setSize(PAGE_SIZE);
            }}
            className="border-border bg-background text-foreground focus:border-accent/60 w-full rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
          >
            {!branches.some((b) => b.name === branch) && (
              <option value="">{branch}</option>
            )}
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        ) : (
          // Same degradation as the app form: without a list, the name is typed.
          <input
            id="version-branch"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setSelected(null);
            }}
            className="border-border bg-background text-foreground focus:border-accent/60 w-full rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
          />
        )}
      </Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-foreground text-sm">Commit</p>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Ricarica i commit"
            onPress={refresh}
          >
            <Icon icon="solar:refresh-linear" width={16} aria-hidden />
          </Button>
        </div>

        {loading && !data ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <SkeletonBlock key={i} className="h-14" />
            ))}
          </div>
        ) : !available ? (
          <EmptyState
            icon="solar:branching-paths-up-linear"
            title="Elenco dei commit non disponibile"
            description={unavailableMessage}
            action={
              data?.reason === "no-token" ? (
                <LinkButton href="/github" variant="secondary">
                  Collega GitHub
                </LinkButton>
              ) : error ? (
                <Button variant="secondary" size="sm" onPress={refresh}>
                  Riprova
                </Button>
              ) : undefined
            }
          />
        ) : commits.length === 0 ? (
          <EmptyState icon="solar:history-linear" title="Nessun commit su questo branch" />
        ) : (
          <div className="border-border max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-[var(--radius)] border">
            {commits.map((commit, index) => {
              const isSelected = selected === commit.sha && manualClean.length === 0;
              return (
                <button
                  key={commit.sha}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSelected(commit.sha);
                    setManual("");
                  }}
                  className={cn(
                    "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
                    // The two branches are mutually exclusive, which is the
                    // condition `selected-quiet` asks for: it carries its own
                    // background and must never meet a `bg-*` on one element.
                    isSelected
                      ? "selected-quiet text-accent"
                      : "text-muted hover:bg-surface-hover"
                  )}
                >
                  <Icon icon="solar:code-linear" width={15} className="mt-0.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm">{commit.message}</span>
                    <span className="text-muted block truncate text-xs">
                      <span className="font-mono">{commit.shortSha}</span>
                      {commit.author && ` · ${commit.author}`}
                      {commit.date && ` · ${formatRelative(commit.date)}`}
                    </span>
                  </span>
                  {index === 0 && <span className="text-meta text-muted shrink-0">ultimo</span>}
                  {commit.sha === project.pinned_sha && (
                    <span className="text-meta text-warning shrink-0">fermo qui</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {available && data?.hasMore && size < MAX_SIZE && (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => setSize((s) => Math.min(s + PAGE_SIZE, MAX_SIZE))}
          >
            Carica altri commit
          </Button>
        )}

        {available && size >= MAX_SIZE && (
          <p className="text-muted text-meta">
            Sono gli ultimi {MAX_SIZE} commit di {branch}. Per andare più indietro, incolla lo SHA
            qui sotto.
          </p>
        )}
      </div>

      <Field
        label="Oppure incolla uno SHA"
        hint="Lo SHA completo del commit, 40 caratteri."
        error={
          manualClean.length > 0 && !manualValid
            ? "Serve lo SHA completo del commit, 40 caratteri esadecimali."
            : undefined
        }
      >
        <TextField
          value={manual}
          onChange={(value) => {
            setManual(value);
            if (value.trim().length > 0) setSelected(null);
          }}
        >
          <Label className="sr-only">SHA del commit</Label>
          <Input placeholder="3f9a2b1c…" className="font-mono text-sm" />
        </TextField>
      </Field>

      {target && (
        <Hint tone="warn" icon="solar:rewind-back-linear">
          <p>
            Il progetto resterà <strong>fermo</strong> su{" "}
            <span className="font-mono">{target.slice(0, 7)}</span>: ogni deploy ricostruirà questo
            commit e l&apos;auto-deploy resterà sospeso finché non lo sblocchi.
          </p>
          {branchChanges && (
            <p className="mt-1.5">
              Il branch del progetto passerà da{" "}
              <span className="font-mono">{project.source_branch}</span> a{" "}
              <span className="font-mono">{branch}</span>.
            </p>
          )}
          {goingBackwards && (
            <p className="mt-1.5">
              È una versione precedente di <span className="font-mono">{branch}</span>: il codice più
              recente resta sul repository, ma non sarà più quello in esecuzione.{" "}
              <strong>Le migrazioni del database non tornano indietro</strong>: se questa versione si
              aspetta uno schema più vecchio, potrebbe non partire.
            </p>
          )}
        </Hint>
      )}
    </FormDialog>
  );
}
