"use client";

import { formatRelative } from "@/lib/format";
import type { UpdateCommit } from "@/lib/panel-update";

/**
 * What the update would actually bring.
 *
 * The one thing that makes pressing the button a decision rather than an act of
 * faith. Subjects are shown verbatim — they carry the emoji and the area prefix
 * this project writes them with, and reformatting them here would only make the
 * list disagree with the repository.
 */
export function Changelog({ commits, total }: { commits: UpdateCommit[]; total: number }) {
  if (commits.length === 0) return null;

  return (
    <div>
      <ol className="border-border divide-border divide-y overflow-hidden rounded-[var(--radius)] border">
        {commits.map((commit) => (
          <li key={commit.sha} className="flex items-baseline gap-3 px-3 py-2">
            <code className="text-muted shrink-0 font-mono text-xs">{commit.short}</code>
            <span className="text-foreground min-w-0 flex-1 text-sm">{commit.subject}</span>
            <span className="text-muted shrink-0 text-xs">
              {formatRelative(commit.date)}
            </span>
          </li>
        ))}
      </ol>

      {total > commits.length && (
        <p className="text-muted mt-2 text-xs">
          Mostrati {commits.length} dei {total} commit.
        </p>
      )}
    </div>
  );
}
