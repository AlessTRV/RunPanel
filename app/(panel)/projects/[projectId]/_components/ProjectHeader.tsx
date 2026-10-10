"use client";

import Link from "next/link";
import { Button, Dropdown } from "@heroui/react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "@/components/StatusBadge";
import { phaseLabel } from "@/lib/deploy-phases";
import type { Project } from "./types";

/**
 * Title, identity and the controls that act on the whole project.
 *
 * Which controls appear is derived from the project's status rather than shown
 * disabled: a Stop button on a stopped project is noise.
 *
 * Two buttons stay in sight — Deploy, and the one state change that fits the
 * status (Avvia or Riavvia) — and the rest sit under "Altro". Up to seven
 * buttons used to sit here, and on a phone they took two rows above a stats
 * strip that pushed the log below the fold.
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
  // Read-only accounts see the state, not the controls: the server refuses
  // them anyway, and a row of buttons that only error is worse than none.
  const canOperate = project.permission?.level !== "read";
  const canStop = project.status === "running" || project.status === "error";
  const canStart = project.status === "stopped" || project.status === "error";
  const canPickVersion = project.source_type === "github" && Boolean(project.source_url);

  /*
    A queue nobody is reminded of is a queue that runs weeks later, on a
    deploy triggered by somebody who never put anything in it. So it is said
    next to the button that will run it, and not only on the tab where it was
    written.
  */
  const oneTime = project.oneTimeCommands ?? [];
  const oneTimePhases = [...new Set(oneTime.map((command) => command.phase))];

  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Link
          href="/projects"
          aria-label="Torna ai progetti"
          className="text-muted hover:text-foreground hover:bg-surface-hover mt-0.5 rounded-[var(--radius)] p-1.5 transition-colors"
        >
          <Icon icon="solar:arrow-left-linear" width={18} />
        </Link>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-foreground truncate text-2xl font-semibold tracking-tight">
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
            {oneTime.length > 0 && (
              <span
                title={oneTimePhases.map(phaseLabel).join(', ')}
                className="border-accent/35 text-accent inline-flex items-center gap-1 rounded-[var(--radius)] border px-1.5 py-0.5 text-meta"
              >
                <Icon icon="solar:bolt-circle-linear" width={12} aria-hidden />
                {oneTime.length === 1
                  ? "1 comando una tantum"
                  : `${oneTime.length} comandi una tantum`}
                {oneTimePhases.length === 1
                  ? ` · ${phaseLabel(oneTimePhases[0])}`
                  : ` · ${oneTimePhases.length} passi`}
              </span>
            )}
            {(project.permission?.level ?? "manage") === "manage" && (
              // It opens the rename dialog, so it says so: as a gear labelled
              // "Impostazioni" it competed with the Impostazioni tab below.
              <button
                type="button"
                onClick={onOpenSettings}
                className="text-muted hover:text-foreground rounded-[var(--radius)] p-1 transition-colors"
                aria-label="Rinomina il progetto"
                title="Rinomina"
              >
                <Icon icon="solar:pen-linear" width={15} aria-hidden />
              </button>
            )}
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

      {canOperate && (
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
        {canStart ? (
          <Button variant="secondary" size="sm" onPress={() => onControl("start")}>
            <Icon icon="solar:play-linear" width={16} aria-hidden />
            Avvia
          </Button>
        ) : canStop ? (
          <Button variant="outline" size="sm" onPress={() => onControl("restart")}>
            <Icon icon="solar:refresh-linear" width={16} aria-hidden />
            Riavvia
          </Button>
        ) : null}

        <Dropdown>
          <Button variant="outline" size="sm" aria-label="Altre azioni">
            <Icon icon="solar:menu-dots-linear" width={16} aria-hidden />
            <span className="hidden sm:inline">Altro</span>
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label="Altre azioni sul progetto"
              disabledKeys={busy || deploying ? ["rebuild", "release"] : []}
              onAction={(key) => {
                if (key === "rebuild") onDeploy("rebuild");
                else if (key === "release") onReleasePin();
                else if (key === "restart") onControl("restart");
                else if (key === "stop") onControl("stop");
              }}
            >
              <Dropdown.Item id="rebuild" textValue="Re-build">
                <Icon icon="solar:refresh-circle-linear" width={14} aria-hidden />
                <span className="flex-1">Re-build da zero</span>
              </Dropdown.Item>
              {/* Only while pinned: an action that means nothing most of the time. */}
              {project.pinned_sha ? (
                <Dropdown.Item id="release" textValue="Torna all'ultimo commit">
                  <Icon icon="solar:rewind-back-linear" width={14} aria-hidden />
                  <span className="flex-1">Torna all&apos;ultimo commit</span>
                </Dropdown.Item>
              ) : null}
              {/* Restart is already a button when the project is running;
                  repeated here only for an errored one, which shows Avvia. */}
              {canStop && canStart ? (
                <Dropdown.Item id="restart" textValue="Riavvia">
                  <Icon icon="solar:refresh-linear" width={14} aria-hidden />
                  <span className="flex-1">Riavvia</span>
                </Dropdown.Item>
              ) : null}
              {canStop ? (
                <Dropdown.Item id="stop" textValue="Ferma" className="text-danger">
                  <Icon icon="solar:stop-linear" width={14} aria-hidden />
                  <span className="flex-1">Ferma</span>
                </Dropdown.Item>
              ) : null}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
      )}
    </header>
  );
}
