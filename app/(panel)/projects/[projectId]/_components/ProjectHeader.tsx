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
}: {
  project: Project;
  busy: boolean;
  onDeploy: (mode: "deploy" | "rebuild") => void;
  onControl: (action: "start" | "stop" | "restart") => void;
  onOpenSettings: () => void;
}) {
  const deploying = project.status === "deploying";
  const canStop = project.status === "running" || project.status === "error";
  const canStart = project.status === "stopped" || project.status === "error";

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
        <Button variant="outline" size="sm" isDisabled={busy || deploying} onPress={() => onDeploy("rebuild")}>
          <Icon icon="solar:refresh-circle-linear" width={16} aria-hidden />
          Re-build
        </Button>

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
