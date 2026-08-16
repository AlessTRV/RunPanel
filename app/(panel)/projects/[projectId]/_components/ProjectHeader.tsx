"use client";

import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "@/components/StatusBadge";
import type { Project } from "./types";

/**
 * Title, identity and the controls that act on the whole project.
 *
 * Which controls appear is derived from the project's status rather than shown
 * disabled: a Stop button on a stopped project is noise.
 */
export function ProjectHeader({
  project,
  busy,
  onDeploy,
  onControl,
  onOpenSettings,
  onOpenVersions,
  onReleasePin,
}: {
  project: Project;
  busy: boolean;
  onDeploy: (mode: "deploy" | "rebuild") => void;
  onControl: (action: "start" | "stop" | "restart") => void;
  onOpenSettings: () => void;
  onOpenVersions: () => void;
  onReleasePin: () => void;
}) {
  const deploying = project.status === "deploying";
  const canStop = project.status === "running" || project.status === "error";
  const canStart = project.status === "stopped" || project.status === "error";
  const canPickVersion = project.source_type === "github" && Boolean(project.source_url);

  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Link
          href="/home"
          aria-label="Torna alla overview"
          className="text-muted hover:text-foreground hover:bg-surface-hover mt-0.5 rounded-[var(--radius)] p-1.5 transition-colors"
        >
          <Icon icon="solar:arrow-left-linear" width={18} />
        </Link>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-foreground truncate text-xl font-semibold tracking-tight">
              {project.name}
            </h1>
            <StatusBadge status={project.status} />
            {/* Next to the status because it qualifies it: the app is running,
                but not from where the branch says. */}
            {project.pinned_sha && (
              <span
                title={
                  project.pinned_at
                    ? `Fermo dal ${new Date(project.pinned_at).toLocaleString()}`
                    : undefined
                }
                className="border-warning/35 text-warning inline-flex items-center gap-1 rounded-[var(--radius)] border px-1.5 py-0.5 text-meta"
              >
                <Icon icon="solar:pin-linear" width={12} aria-hidden />
                Fermo su <span className="font-mono">{project.pinned_sha.slice(0, 7)}</span>
              </span>
            )}
            <button
              type="button"
              onClick={onOpenSettings}
              className="text-muted hover:text-foreground transition-colors"
              aria-label="Impostazioni del progetto"
            >
              <Icon icon="solar:settings-linear" width={16} />
            </button>
          </div>

          <p className="text-muted mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-mono">{project.runtime_type}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">:{project.port ?? "auto"}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{project.source_branch}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" isPending={busy} isDisabled={deploying} onPress={() => onDeploy("deploy")}>
          <Icon icon="solar:upload-linear" width={16} aria-hidden />
          Deploy
        </Button>
        {/* Deploy sends what the project points at; this is where you change
            what that is. Icon-only and adjacent, so the pair reads as one
            control rather than as two competing actions.

            Absent for an uploaded ZIP: there is no timeline behind it, and a
            button whose only outcome is an explanation of why it cannot work is
            worse than no button. */}
        {canPickVersion && (
          <Button
            variant="outline"
            size="sm"
            isIconOnly
            isDisabled={busy || deploying}
            aria-label="Scegli la versione da distribuire"
            onPress={onOpenVersions}
          >
            <Icon icon="solar:branching-paths-up-linear" width={16} aria-hidden />
          </Button>
        )}
        <Button variant="outline" size="sm" isDisabled={busy || deploying} onPress={() => onDeploy("rebuild")}>
          <Icon icon="solar:refresh-circle-linear" width={16} aria-hidden />
          Re-build
        </Button>

        {/* Only while pinned, so the header is not permanently crowded by an
            action that means nothing most of the time. */}
        {project.pinned_sha && (
          <Button variant="outline" size="sm" isDisabled={busy || deploying} onPress={onReleasePin}>
            <Icon icon="solar:rewind-back-linear" width={16} aria-hidden />
            Torna all&apos;ultimo commit
          </Button>
        )}

        {canStop && (
          <>
            <Button variant="outline" size="sm" onPress={() => onControl("restart")}>
              <Icon icon="solar:refresh-linear" width={16} aria-hidden />
              Riavvia
            </Button>
            <Button variant="outline" size="sm" onPress={() => onControl("stop")}>
              <Icon icon="solar:stop-linear" width={16} aria-hidden />
              Ferma
            </Button>
          </>
        )}

        {canStart && (
          <Button variant="secondary" size="sm" onPress={() => onControl("start")}>
            <Icon icon="solar:play-linear" width={16} aria-hidden />
            Avvia
          </Button>
        )}
      </div>
    </header>
  );
}
