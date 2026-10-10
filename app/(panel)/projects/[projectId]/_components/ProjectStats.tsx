"use client";

import { memo } from "react";
import { StatTile } from "@/components/ui/StatTile";
import { formatBytes, formatUptime } from "@/lib/format";
import { type ProcessInfo } from "./types";

/**
 * Memoised: this re-renders on a 5-second status poll, and there is no reason
 * for it to re-render when a log line arrives — which, on a busy project, is
 * many times a second.
 */
export const ProjectStats = memo(function ProjectStats({ info }: { info: ProcessInfo | null }) {
  // Nothing to measure while the process is down, and the status badge in the
  // header already says so. Four tiles of dashes used to fill the space where
  // the log should have been. The "Stato" tile is gone for the same reason: it
  // repeated the badge.
  if (!info?.running) return null;

  return (
    <div className="mb-6 grid grid-cols-3 gap-3">
      <StatTile
        icon="solar:clock-circle-linear"
        label="Uptime"
        value={formatUptime(info.uptime)}
        hint={info.pid ? `PID ${info.pid}` : undefined}
      />
      <StatTile
        icon="solar:server-linear"
        label="Memoria"
        value={formatBytes(info.memory)}
      />
      <StatTile
        icon="solar:cpu-linear"
        label="CPU"
        value={info.cpu != null ? `${info.cpu}%` : "—"}
        percent={info.cpu ?? undefined}
      />
    </div>
  );
});
