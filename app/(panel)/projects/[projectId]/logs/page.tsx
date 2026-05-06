"use client";

import { Icon } from "@iconify/react";

export default function LogsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Logs</h1>
        <p className="text-sm text-foreground-400">Real-time application logs</p>
      </div>
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-divider py-20">
        <Icon icon="solar:document-text-bold-duotone" className="mb-4 text-foreground-300" width={48} />
        <p className="text-foreground-400">Real-time logs coming soon</p>
        <p className="text-sm text-foreground-500">WebSocket log streaming will be available after deploy pipeline is active</p>
      </div>
    </div>
  );
}
