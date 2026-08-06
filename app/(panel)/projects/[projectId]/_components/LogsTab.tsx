"use client";

import { memo } from "react";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";

/**
 * Build output and process output.
 *
 * The build panel only appears while a deploy is producing lines — that view
 * did not exist before: the build log could only be read from a deployment
 * that had already finished.
 */
export const LogsTab = memo(function LogsTab({
  deployLog,
  processLog,
  connected,
}: {
  deployLog: LogLine[];
  processLog: LogLine[];
  connected: boolean;
}) {
  return (
    <div className="space-y-5">
      {deployLog.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-foreground text-sm font-medium">Deploy in corso</h2>
            <span className="bg-warning size-1.5 animate-pulse rounded-full" aria-hidden />
          </div>
          <LogViewer lines={deployLog} className="h-[240px]" ariaLabel="Output del build" />
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-foreground text-sm font-medium">Output del processo</h2>
          <span
            className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-muted"}`}
            title={connected ? "Stream connesso" : "Stream disconnesso"}
            aria-label={connected ? "Stream connesso" : "Stream disconnesso"}
          />
        </div>
        <LogViewer
          lines={processLog}
          className="h-[320px] sm:h-[440px]"
          emptyMessage="In attesa dell'output del processo…"
          ariaLabel="Output del processo"
        />
      </section>
    </div>
  );
});
