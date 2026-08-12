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
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        icon="solar:shield-check-linear"
        label="Stato"
        value={info?.running ? "Online" : "Offline"}
        hint={info?.pid ? `PID ${info.pid}` : undefined}
      />
      <StatTile
        icon="solar:clock-circle-linear"
        label="Uptime"
        value={formatUptime(info?.uptime)}
      />
      <StatTile
        icon="solar:server-linear"
        label="Memoria"
        value={formatBytes(info?.memory)}
      />
      <StatTile
        icon="solar:cpu-linear"
        label="CPU"
        value={info?.cpu != null ? `${info.cpu}%` : "—"}
        percent={info?.cpu ?? undefined}
      />
    </div>
  );
});
