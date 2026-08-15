"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { AppForm } from "@/components/AppForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { cn } from "@/lib/utils";

/**
 * Creating a project used to ask for a name and nothing else, dropping you on
 * the project page with no source configured — and the only way to attach code
 * was a form filed under "Services → New", which nobody would think to look
 * for. A project with no source deploys nothing, so the source question is now
 * part of creating one.
 */
export default function NewProjectPage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [project, setProject] = useState<{ id: string; slug: string } | null>(null);

  async function createProject() {
    if (!name.trim()) {
      toast.error("Serve un nome per il progetto");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Creazione non riuscita");
        return;
      }

      // Straight on to the source step — the project exists, but it cannot do
      // anything yet.
      setProject({ id: data.id, slug: data.slug });
    } catch {
      toast.error("Creazione non riuscita");
    } finally {
      setCreating(false);
    }
  }

  const step = project ? 2 : 1;

  return (
    <>
      <PageHeader
        title="Nuovo progetto"
        description={
          step === 1
            ? "Un progetto raggruppa un'app e i servizi di cui ha bisogno"
            : `Da dove arriva il codice di ${name}`
        }
      />

      <ol className="mb-6 flex items-center gap-3" aria-label="Avanzamento">
        {[
          { n: 1, label: "Nome" },
          { n: 2, label: "Sorgente e runtime" },
        ].map(({ n, label }) => (
          <li key={n} className="flex items-center gap-3">
            <span
              className={cn(
                "flex items-center gap-2 text-sm transition-colors",
                step === n ? "text-foreground" : "text-muted"
              )}
              aria-current={step === n ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border font-mono text-meta",
                  step > n
                    ? "border-accent text-accent"
                    : step === n
                      ? "selected border-transparent text-accent"
                      : "border-border text-muted"
                )}
              >
                {step > n ? <Icon icon="solar:check-read-linear" width={12} aria-hidden /> : n}
              </span>
              {label}
            </span>
            {n === 1 && <span className="bg-border h-px w-8" aria-hidden />}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <div className="max-w-md">
          <Panel className="space-y-4">
            <PanelHeader title="Nome" description="Diventa anche lo slug su disco e in Docker" />
            <TextField value={name} onChange={setName} autoFocus>
              <Label>Nome</Label>
              <Input
                placeholder="il-mio-progetto"
                onKeyDown={(e) => e.key === "Enter" && createProject()}
              />
            </TextField>
            <div className="flex justify-end">
              <Button variant="primary" isPending={creating} onPress={createProject}>
                Continua
              </Button>
            </div>
          </Panel>
        </div>
      ) : (
        <AppForm
          projectId={project!.id}
          submitLabel="Salva e apri il progetto"
          secondaryAction={
            <button
              type="button"
              onClick={() => router.push(`/projects/${project!.id}`)}
              className="text-muted hover:text-foreground text-sm transition-colors"
            >
              Configuro dopo
            </button>
          }
        />
      )}
    </>
  );
}
