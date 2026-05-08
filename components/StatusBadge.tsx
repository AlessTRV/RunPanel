"use client";

import { Chip } from "@heroui/react";

type Status = "stopped" | "running" | "deploying" | "error" | "pending" | "building" | "failed" | "superseded" | "checking";

const statusConfig: Record<Status, { variant: "primary" | "secondary" | "tertiary" | "soft"; className: string; label: string }> = {
  running: { variant: "soft", className: "text-success bg-success/10", label: "Running" },
  stopped: { variant: "soft", className: "text-foreground-400 bg-default-100", label: "Stopped" },
  deploying: { variant: "soft", className: "text-warning bg-warning/10", label: "Deploying" },
  error: { variant: "soft", className: "text-danger bg-danger/10", label: "Error" },
  pending: { variant: "soft", className: "text-foreground-400 bg-default-100", label: "Pending" },
  building: { variant: "soft", className: "text-warning bg-warning/10", label: "Building" },
  failed: { variant: "soft", className: "text-danger bg-danger/10", label: "Failed" },
  superseded: { variant: "soft", className: "text-success/60 bg-success/5", label: "Completed" },
  checking: { variant: "soft", className: "text-foreground-400 bg-default-100 animate-pulse", label: "Checking..." },
};

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status as Status] || statusConfig.stopped;
  return (
    <Chip size="sm" variant={config.variant} className={config.className}>
      {config.label}
    </Chip>
  );
}
