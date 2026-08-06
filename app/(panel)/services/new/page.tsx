"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";
import { DOCKER_TEMPLATES, dockerTemplate } from "./_data/catalog";
import { AppForm } from "@/components/AppForm";
import { DatabaseForm } from "./_components/DatabaseForm";
import { TemplateForm } from "./_components/TemplateForm";

type Choice = { kind: "app" } | { kind: "database" } | { kind: "template"; id: string };

/**
 * Picks what to add to a project, then hands off to the matching form.
 *
 * This file used to be 500 lines holding all three branches, their state and
 * the template catalogue — the catalogue being rebuilt on every render.
 */
export default function NewServicePage() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const [choice, setChoice] = useState<Choice | null>(null);

  if (!projectId) {
    return (
      <>
        <PageHeader title="Aggiungi al progetto" />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Nessun progetto selezionato"
            description="Apri un progetto e usa il pulsante per aggiungere un'app o un servizio."
          />
        </Panel>
      </>
    );
  }

  if (choice) {
    const title =
      choice.kind === "app"
        ? "Aggiungi un'app"
        : choice.kind === "database"
          ? "Aggiungi un database"
          : dockerTemplate(choice.id)?.label ?? "Template";

    return (
      <>
        <PageHeader
          title={title}
          actions={
            <button
              type="button"
              onClick={() => setChoice(null)}
              className="text-muted hover:text-foreground flex items-center gap-1.5 text-sm transition-colors"
            >
              <Icon icon="solar:arrow-left-linear" width={16} aria-hidden />
              Cambia
            </button>
          }
        />

        {choice.kind === "app" && <AppForm projectId={projectId} />}
        {choice.kind === "database" && <DatabaseForm projectId={projectId} />}
        {choice.kind === "template" && dockerTemplate(choice.id) && (
          <TemplateForm projectId={projectId} template={dockerTemplate(choice.id)!} />
        )}
      </>
    );
  }

  const cards = [
    {
      key: "app",
      title: "App",
      description: "Il tuo codice, da GitHub o da uno ZIP",
      icon: "solar:code-linear",
      onSelect: () => setChoice({ kind: "app" }),
    },
    {
      key: "database",
      title: "Database",
      description: "PostgreSQL, MySQL, Redis o MongoDB",
      icon: "solar:database-linear",
      onSelect: () => setChoice({ kind: "database" }),
    },
    ...DOCKER_TEMPLATES.map((tpl) => ({
      key: tpl.id,
      title: tpl.label,
      description: tpl.description,
      icon: tpl.icon,
      onSelect: () => setChoice({ kind: "template", id: tpl.id }),
    })),
  ];

  return (
    <>
      <PageHeader title="Aggiungi al progetto" description="Scegli cosa aggiungere" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={card.onSelect}
            className={cn(
              "border-border bg-surface hover:border-separator hover:bg-surface-hover",
              "flex flex-col gap-2 rounded-[var(--radius)] border p-4 text-left transition-colors"
            )}
          >
            <Icon icon={card.icon} width={22} className="text-muted" aria-hidden />
            <span className="text-foreground text-sm font-medium">{card.title}</span>
            <span className="text-muted text-xs">{card.description}</span>
          </button>
        ))}
      </div>
    </>
  );
}
