"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Ctrl/Cmd+K: go anywhere, do the frequent things.
 *
 * It indexes what the panel already serves — projects and services — rather
 * than adding a search endpoint. That keeps it instant, adds no authenticated
 * surface, and means there is nothing new to keep in sync with the data.
 *
 * The lists are fetched the first time it opens, not on every page load: a
 * shortcut nobody presses should cost nothing.
 */

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void | Promise<void>;
}

const PAGES: { label: string; href: string; icon: string; keys?: string }[] = [
  { label: "Overview", href: "/home", icon: "solar:widget-2-linear" },
  { label: "Progetti", href: "/projects", icon: "solar:folder-linear", keys: "g p" },
  { label: "Servizi", href: "/services", icon: "solar:database-linear", keys: "g s" },
  { label: "Monitor", href: "/monitor", icon: "solar:chart-2-linear" },
  { label: "Storage", href: "/storage", icon: "solar:ssd-square-linear" },
  { label: "Backup", href: "/backups", icon: "solar:archive-linear", keys: "g b" },
  { label: "Avvio automatico", href: "/autostart", icon: "solar:power-linear" },
  { label: "Diagnostica", href: "/diagnostics", icon: "solar:health-linear" },
  { label: "GitHub", href: "/github", icon: "solar:code-linear" },
  { label: "Impostazioni", href: "/account", icon: "solar:settings-linear" },
];

interface Indexed {
  projects: { id: string; name: string; slug: string }[];
  services: { id: string; name: string; type: string }[];
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<Indexed>({ projects: [], services: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const chord = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [projects, services] = await Promise.all([
        fetch("/api/projects").then((res) => (res.ok ? res.json() : [])),
        fetch("/api/services").then((res) => (res.ok ? res.json() : [])),
      ]);
      setIndex({
        projects: Array.isArray(projects) ? projects : [],
        services: Array.isArray(services) ? services : [],
      });
    } catch {
      /* the static pages are still worth offering */
    }
  }, []);

  // Opening, and the `g x` chords. The guard matters: without it, typing "g"
  // into any field on any page would start a navigation chord.
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      const tag = element.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
    };

    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          setOpen(false);
        } else {
          // Fetched here rather than in an effect: the index is a response to
          // the keypress, and a shortcut nobody presses should cost nothing.
          void load();
          setOpen(true);
        }
        return;
      }

      if (event.key === "Escape" && open) {
        setOpen(false);
        return;
      }

      if (open || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

      if (chord.current === "g") {
        chord.current = null;
        const page = PAGES.find((candidate) => candidate.keys === `g ${event.key.toLowerCase()}`);
        if (page) {
          event.preventDefault();
          router.push(page.href);
        }
        return;
      }

      if (event.key.toLowerCase() === "g") {
        chord.current = "g";
        // A chord that is never completed should not wait forever.
        setTimeout(() => (chord.current = null), 1500);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, router, load]);

  useEffect(() => {
    // Focus only: the input exists only once open is true, so this cannot be
    // done from the handler that opened it.
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = PAGES.map((page) => ({
      id: `page:${page.href}`,
      label: page.label,
      hint: page.keys,
      icon: page.icon,
      run: () => router.push(page.href),
    }));

    for (const project of index.projects) {
      list.push({
        id: `project:${project.id}`,
        label: project.name,
        hint: `progetto · ${project.slug}`,
        icon: "solar:folder-linear",
        run: () => router.push(`/projects/${project.id}`),
      });
    }

    for (const service of index.services) {
      list.push({
        id: `service:${service.id}`,
        label: service.name,
        hint: `servizio · ${service.type}`,
        icon: "solar:database-linear",
        run: () => router.push(`/services/${service.id}`),
      });
    }

    list.push({
      id: "action:new-project",
      label: "Nuovo progetto",
      hint: "azione",
      icon: "solar:add-circle-linear",
      run: () => router.push("/projects/new"),
    });
    list.push({
      id: "action:new-backup",
      label: "Nuova pianificazione di backup",
      hint: "azione",
      icon: "solar:archive-linear",
      run: () => router.push("/backups/new"),
    });
    list.push({
      id: "action:reconcile",
      label: "Simula l'avvio automatico",
      hint: "azione",
      icon: "solar:power-linear",
      run: async () => {
        const res = await fetch("/api/autostart/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: true }),
        });
        const body = await res.json();
        toast.success(
          res.ok
            ? `${(body.entries ?? []).filter((entry: { action: string }) => entry.action === "would-start").length} elementi verrebbero avviati`
            : "Simulazione non riuscita"
        );
      },
    });

    return list;
  }, [index, router]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.slice(0, 12);
    return commands
      .filter((command) =>
        `${command.label} ${command.hint ?? ""}`.toLowerCase().includes(needle)
      )
      .slice(0, 12);
  }, [commands, query]);

  if (!open) return null;

  const choose = async (command: Command) => {
    setOpen(false);
    setQuery("");
    await command.run();
  };

  return (
    <div
      className="bg-backdrop fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="border-border bg-overlay shadow-overlay w-full max-w-lg overflow-hidden rounded-[var(--radius)] border"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Cerca ed esegui"
        aria-modal
      >
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Icon icon="solar:magnifer-linear" width={16} className="text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, filtered.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              }
              if (event.key === "Enter" && filtered[active]) {
                event.preventDefault();
                void choose(filtered[active]);
              }
            }}
            placeholder="Cerca progetti, servizi, pagine…"
            className="text-foreground placeholder:text-muted h-11 flex-1 bg-transparent text-sm outline-none"
            aria-label="Cerca"
          />
          <kbd className="text-muted border-border rounded border px-1.5 py-0.5 text-[10px]">
            esc
          </kbd>
        </div>

        <ul className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <li className="text-muted px-3 py-6 text-center text-sm">Nessun risultato.</li>
          )}
          {filtered.map((command, position) => (
            <li key={command.id}>
              <button
                type="button"
                onClick={() => void choose(command)}
                onMouseEnter={() => setActive(position)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-left text-sm",
                  position === active ? "bg-default text-foreground" : "text-muted"
                )}
              >
                <Icon icon={command.icon} width={16} aria-hidden />
                <span className="text-foreground flex-1 truncate">{command.label}</span>
                {command.hint && <span className="text-muted text-xs">{command.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
