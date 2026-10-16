"use client";

import { usePathname } from "next/navigation";
import { SelectField } from "@/components/ui/SelectField";
import { useNode } from "@/lib/hooks/useNode";
import { isAggregatePath } from "@/lib/server-url";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/**
 * Which server the page shows. It writes `?server=` into the URL, so what is
 * selected travels with every link. On list pages "Tutti i server" shows every
 * server at once; on a page about one server it is not offered. Hidden in solo
 * mode.
 */
export function ServerSelector({ className }: { className?: string }) {
  const { nodes, serverParam, selected, select, isSolo, selfId } = useNode();
  const pathname = usePathname();
  if (isSolo) return null;

  const aggregate = isAggregatePath(pathname);
  const value = aggregate ? (serverParam ?? ALL) : selected;

  return (
    <SelectField
      ariaLabel="Server"
      className={cn("w-44 sm:w-52", className)}
      value={value}
      onChange={(v) => select(v === ALL || (!aggregate && v === selfId) ? null : v)}
      options={[
        ...(aggregate ? [{ value: ALL, label: "Tutti i server" }] : []),
        ...nodes.map((n) => ({
          value: n.id,
          label: n.id === selfId ? `${n.name} (questo)` : n.status === "unreachable" ? `${n.name} · non raggiungibile` : n.name,
        })),
      ]}
    />
  );
}
