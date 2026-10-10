"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { NAV_PAGES } from "@/lib/nav";
import { useAllowedNav } from "@/lib/hooks/useMe";
import { serviceDisplayName } from "@/lib/service-name";

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


interface Indexed {
  projects: { id: string; name: string; slug: string }[];
  services: { id: string; name: string; type: string }[];
}

export function CommandPalette() {
  const router = useRouter();
  // The same destinations the sidebar shows, from the same list and filter.
  const allowed = useAllowedNav();
  const PAGES = useMemo(() => NAV_PAGES.filter(allowed), [allowed]);
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
  }, [open, router, load, PAGES]);

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
        label: serviceDisplayName(service),
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
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(body.error || "Simulazione non riuscita");
          return;
        }
        toast.success(
          `${(body.entries ?? []).filter((entry: { action: string }) => entry.action === "would-start").length} elementi verrebbero avviati`
        );
      },
    });

    return list;
  }, [index, router, PAGES]);

  // Keeps the highlighted row in view while the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`palette-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

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
          {/* A combobox over a listbox: the focus stays in the field, and
              aria-activedescendant tells a screen reader which row the arrows
              are on. The rows used to be plain buttons the reader never heard
              about while typing. */}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? `palette-option-${active}` : undefined}
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
          {/* A key hint means nothing on a phone, which has no Esc: there the
              way out is a button. */}
          <kbd className="text-muted border-border hidden rounded border px-1.5 py-0.5 text-meta sm:inline-block">
            esc
          </kbd>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-muted hover:text-foreground -mr-1 p-1 sm:hidden"
            aria-label="Chiudi"
          >
            <Icon icon="solar:close-circle-linear" width={18} aria-hidden />
          </button>
        </div>

        {filtered.length === 0 && (
          <p className="text-muted px-3 py-6 text-center text-sm">Nessun risultato.</p>
        )}
        <ul id="palette-list" role="listbox" aria-label="Risultati" className="max-h-80 overflow-y-auto p-1">
          {filtered.map((command, position) => (
            <li
              key={command.id}
              id={`palette-option-${position}`}
              role="option"
              aria-selected={position === active}
            >
              <div
                onClick={() => void choose(command)}
                onMouseEnter={() => setActive(position)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-left text-sm",
                  // The palette lists the same destinations as the sidebar, from
                  // the same array, with the same icons — so the highlighted row
                  // should look like the sidebar's, not like a grey rectangle.
                  position === active ? "selected text-foreground" : "text-muted"
                )}
              >
                <Icon
                  icon={command.icon}
                  width={16}
                  aria-hidden
                  className={cn(position === active && "text-accent")}
                />
                <span className="text-foreground flex-1 truncate">{command.label}</span>
                {command.hint && <span className="text-muted text-xs">{command.hint}</span>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
