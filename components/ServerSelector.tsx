"use client";

import { SelectField } from "@/components/ui/SelectField";
import { useNode } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";

const STATUS_LABEL = { ok: "raggiungibile", unreachable: "non raggiungibile", unknown: "stato sconosciuto" } as const;

/**
 * Which server the pages show. Hidden in solo mode: a selector with one
 * entry would only raise the question it answers.
 */
export function ServerSelector({ className }: { className?: string }) {
  const { nodes, selected, select, isSolo, selfId } = useNode();
  if (isSolo) return null;

  return (
    <SelectField
      ariaLabel="Server"
      className={cn("w-44 sm:w-52", className)}
      value={selected}
      onChange={select}
      options={nodes.map((n) => ({
        value: n.id,
        label: n.id === selfId ? `${n.name} (questo)` : n.status === "ok" ? n.name : `${n.name} · ${STATUS_LABEL[n.status]}`,
      }))}
    />
  );
}
