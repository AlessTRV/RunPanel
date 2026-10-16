"use client";

import { Icon } from "@iconify/react";
import { SelectField } from "@/components/ui/SelectField";
import { Hint } from "@/components/ui/Hint";
import type { MemberStatus } from "@/lib/cluster-merge";
import { useNode } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";

/**
 * The small pieces every multi-server page shares. Each renders nothing in
 * solo mode, so a page can use them unconditionally and look exactly as it
 * did before a cluster existed.
 */

const ALL = "__all__";

/** Which server a row lives on. */
export function ServerBadge({ memberId, className }: { memberId: string | null | undefined; className?: string }) {
  const { isSolo, nodes, selfId } = useNode();
  if (isSolo || !memberId) return null;
  const node = nodes.find((n) => n.id === memberId);
  if (!node) return null;
  return (
    <span
      className={cn("bg-default text-muted inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs", className)}
      title={node.id === selfId ? "Questo server" : node.url}
    >
      <Icon icon="solar:server-2-linear" width={12} aria-hidden />
      {node.name}
    </span>
  );
}

/** Narrow a list to one server, or show every server. Writes `?server=`. */
export function ServerFilter({ className }: { className?: string }) {
  const { isSolo, nodes, serverParam, select, selfId } = useNode();
  if (isSolo) return null;
  return (
    <SelectField
      ariaLabel="Server"
      // The top bar has the same selector on wider screens; this one is for phones.
      className={cn("w-44 sm:hidden", className)}
      value={serverParam ?? ALL}
      onChange={(v) => select(v === ALL ? null : v)}
      options={[
        { value: ALL, label: "Tutti i server" },
        ...nodes.map((n) => ({ value: n.id, label: n.id === selfId ? `${n.name} (questo)` : n.name })),
      ]}
    />
  );
}

/**
 * Where something new is created. Choosing a server writes `?server=`, so
 * every call the form makes from then on goes to that server.
 */
export function ServerPicker({ className, description }: { className?: string; description?: string }) {
  const { isSolo, nodes, selected, select, selfId } = useNode();
  if (isSolo) return null;
  return (
    <div className={className}>
      <SelectField
        label="Server"
        value={selected}
        onChange={(v) => select(v === selfId ? null : v)}
        options={nodes.map((n) => ({
          value: n.id,
          label: n.id === selfId ? `${n.name} (questo)` : n.name,
          description: n.role === "node" ? "Nodo" : "Pannello",
        }))}
      />
      {description && <p className="text-muted mt-1 text-xs">{description}</p>}
    </div>
  );
}

/** One line per server that did not answer, so a shorter list is never mistaken for the whole one. */
export function UnreachableServers({ failed, what, className }: { failed: MemberStatus[]; what: string; className?: string }) {
  if (failed.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {failed.map((m) => (
        <Hint key={m.id} tone={m.reachable ? "info" : "warn"}>
          {m.reachable
            ? `${m.name}: ${what} non disponibili per il tuo account (${m.error ?? "accesso negato"}).`
            : `${m.name} non raggiungibile: ${what} di questo server non sono in elenco. ${m.error ?? ""}`}
        </Hint>
      ))}
    </div>
  );
}
