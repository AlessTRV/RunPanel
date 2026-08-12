"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Code, Hint } from "@/components/ui/Hint";
import { cn } from "@/lib/utils";
import { DOCKER_TEMPLATES, dockerTemplate } from "./_data/catalog";
import { AppForm } from "@/components/AppForm";
import { DatabaseForm } from "./_components/DatabaseForm";
import { TemplateForm } from "./_components/TemplateForm";

type Choice = { kind: "app" } | { kind: "database" } | { kind: "template"; id: string };

/**
 * Picks what to add, then hands off to the matching form.
 *
 * `projectId` is optional. Without one this page used to stop at "Nessun
 * progetto selezionato", which made the "Nuovo servizio" button on /services —
 * the only one reachable from the sidebar — a dead end, and left standalone
 * services impossible to create even though the schema and the API had always
 * accepted them.
 *
 * App and the Docker templates are a different matter: both PATCH the project's
 * own app configuration rather than creating a service, so they genuinely need
 * one. They stay on the page as links to where that choice lives, because a
 * card that disappears teaches nothing about where Nginx went.
 */
export default function NewServicePage() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const [choice, setChoice] = useState<Choice | null>(null);

  if (choice) {
    const title =
      choice.kind === "app"
        ? "Aggiungi un'app"
        : choice.kind === "database"
          ? projectId
            ? "Aggiungi un database"
            : "Nuovo database"
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

        {choice.kind === "app" && projectId && <AppForm projectId={projectId} />}
        {choice.kind === "database" && <DatabaseForm projectId={projectId || undefined} />}
        {choice.kind === "template" && projectId && dockerTemplate(choice.id) && (
          <TemplateForm projectId={projectId} template={dockerTemplate(choice.id)!} />
        )}
      </>
    );
  }

  const cards = [
    {
      key: "database",
      title: "Database",
      description: "PostgreSQL, MySQL, Redis o MongoDB",
      icon: "solar:database-linear",
      onSelect: () => setChoice({ kind: "database" }),
    },
    {
      key: "app",
      title: "App",
      description: "Il tuo codice, da GitHub o da uno ZIP",
      icon: "solar:code-linear",
      onSelect: () => setChoice({ kind: "app" }),
    },
    ...DOCKER_TEMPLATES.map((tpl) => ({
      key: tpl.id,
      title: tpl.label,
      description: tpl.description,
      icon: tpl.icon,
      onSelect: () => setChoice({ kind: "template", id: tpl.id }),
    })),
  ];

  const cardClass =
    "border-border bg-surface flex flex-col gap-2 rounded-[var(--radius)] border p-4 text-left transition-colors";

  return (
    <>
      <PageHeader
        title={projectId ? "Aggiungi al progetto" : "Nuovo servizio"}
        description={projectId ? "Scegli cosa aggiungere" : "Un database o una cache, con o senza progetto"}
      />

      {projectId ? (
        <Hint tone="tip" icon="solar:link-circle-linear" className="mb-4">
          Un progetto tiene insieme l&apos;app e ciò che le serve. Tutto quello che aggiungi qui
          finisce sulla stessa rete Docker: un database creato adesso arriva all&apos;app come{" "}
          <Code>DATABASE_URL</Code> al primo deploy, senza che tu debba copiare credenziali da
          nessuna parte.
        </Hint>
      ) : (
        <Hint icon="solar:database-linear" className="mb-4">
          Un database creato da qui è autonomo: nessun progetto lo possiede e nessuna variabile
          viene iniettata da sola. Alla fine trovi la sua connection string pronta da incollare
          dove ti serve — anche in più progetti. Puoi comunque assegnarlo a un progetto qui sotto,
          e in quel caso torna a collegarsi da solo.
        </Hint>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const needsProject = card.key !== "database" && !projectId;

          const inner = (
            <>
              <Icon icon={card.icon} width={22} className="text-muted" aria-hidden />
              <span className={cn("text-sm font-medium", needsProject ? "text-muted" : "text-foreground")}>
                {card.title}
              </span>
              <span className="text-muted text-xs">
                {needsProject ? "Si configura da dentro un progetto" : card.description}
              </span>
            </>
          );

          return needsProject ? (
            <Link
              key={card.key}
              href="/projects"
              className={cn(cardClass, "border-dashed hover:bg-surface-hover")}
            >
              {inner}
            </Link>
          ) : (
            <button
              key={card.key}
              type="button"
              onClick={card.onSelect}
              className={cn(cardClass, "hover:border-separator hover:bg-surface-hover")}
            >
              {inner}
            </button>
          );
        })}
      </div>
    </>
  );
}
