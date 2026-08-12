"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { connectionEnvKey } from "@/lib/service-env";
import { cn } from "@/lib/utils";
import { DATABASE_OPTIONS, databaseOption, type ServiceType } from "../_data/catalog";

/** Mirrors `serviceNameSchema`: a bad name should not need a round trip. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function DatabaseForm({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<ServiceType>("postgresql");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("16");
  const [port, setPort] = useState("5432");
  const [user, setUser] = useState("runpanel");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("runpanel_db");
  // Seeded from the entry point, then editable: arriving from a project
  // pre-selects it, arriving from Servizi starts on "nessuno".
  const [project, setProject] = useState(projectId ?? "");

  const { data: projectsData } = useResource<{ id: string; name: string; slug: string }[]>(
    "/api/projects"
  );
  const projects = Array.isArray(projectsData) ? projectsData : [];
  const projectSlug = projects.find((p) => p.id === project)?.slug;

  const option = databaseOption(type);

  function chooseType(next: ServiceType) {
    const opt = databaseOption(next);
    setType(next);
    setVersion(opt.versions[0]);
    setPort(String(opt.defaultPort));
    setUser(opt.credentialled ? "runpanel" : "");
    setDatabase(opt.credentialled ? "runpanel_db" : "0");
    setPassword("");
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Serve un nome per il servizio");
      return;
    }
    if (!NAME_PATTERN.test(trimmed)) {
      toast.error("Il nome può contenere solo minuscole, numeri, trattini e underscore");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          type,
          version,
          port: Number.parseInt(port, 10),
          projectId: project || undefined,
          credentials: {
            user: user.trim() || undefined,
            password: password || undefined,
            database: database.trim() || undefined,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Creazione non riuscita");
        return;
      }
      toast.success("Servizio creato");
      // Without a project there is nowhere else to go that shows what was just
      // made — and the connection string is the reason someone created it.
      router.push(project ? `/projects/${project}` : `/services/${data.id}`);
    } catch {
      toast.error("Creazione non riuscita");
    } finally {
      setSaving(false);
    }
  }

  const envKey = connectionEnvKey(type);

  return (
    <div className="max-w-2xl space-y-4">
      {project ? (
        <Hint tone="tip" icon="solar:link-circle-linear" title="Cosa succede dopo">
          Il container viene creato subito, con un volume dedicato per i dati. Dal deploy successivo
          il progetto riceve <Code>{envKey}</Code> già pronta — host, porta, utente e password
          corretti per il runtime che stai usando. Non devi copiare niente a mano. Se un giorno
          preferisci una connection string tua, spegni l&apos;iniezione dal collegamento e il progetto
          torna a usare le sue variabili.
        </Hint>
      ) : (
        <Hint icon="solar:database-linear" title="Cosa succede dopo">
          Il container viene creato subito, con un volume dedicato per i dati. Senza progetto
          nessuna variabile viene iniettata da nessuna parte: la pagina del servizio ti dà la
          connection string pronta, e la incolli come <Code>{envKey}</Code> tra le variabili di chi
          lo deve usare — quanti progetti vuoi.
        </Hint>
      )}

      <Panel className="space-y-4">
        <PanelHeader title="Progetto" description="Facoltativo: decide solo chi lo riceve in automatico" />

        {/* A native select, like the branch picker in AppForm: the list is plain
            data, and this is keyboard- and screen-reader-correct for free. */}
        <div>
          <label htmlFor="service-project" className="text-muted mb-1 block text-sm font-medium">
            Progetto
          </label>
          <select
            id="service-project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="border-border bg-background text-foreground focus:border-accent/60 w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none"
          >
            <option value="">Nessuno — servizio autonomo</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <FieldHint>
            Con un progetto: stessa rete Docker e <Code>{envKey}</Code> iniettata a ogni deploy.
            Senza: il servizio resta a sé e lo colleghi copiando la sua URL dove serve.
          </FieldHint>
        </div>
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader title="Tipo" description="Il container viene provisionato con un volume dedicato" />

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DATABASE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              onClick={() => chooseType(opt.type)}
              aria-pressed={type === opt.type}
              className={cn(
                "flex flex-col items-center gap-2 rounded-[var(--radius)] border px-3 py-4 transition-colors",
                type === opt.type ? "border-accent bg-surface-secondary" : "border-border hover:bg-surface-hover"
              )}
            >
              <Icon icon={opt.icon} width={22} className="text-muted" aria-hidden />
              <span className="text-foreground text-xs">{opt.label}</span>
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <TextField value={name} onChange={setName}>
              <Label>Nome del servizio</Label>
              <Input placeholder="db" />
            </TextField>
            <FieldHint>
              Diventa il nome del container:{" "}
              <Code>
                runpanel-svc-{projectSlug ? `${projectSlug}-` : ""}
                {name.trim() || "nome"}
              </Code>
              . Solo minuscole, numeri, trattini e underscore.
              {!project && " Senza progetto il nome deve essere unico tra i servizi autonomi."}
            </FieldHint>
          </div>

          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Versione</span>
            <div className="flex flex-wrap gap-2">
              {option.versions.map((v) => (
                <Button key={v} size="sm" variant={version === v ? "primary" : "outline"} onPress={() => setVersion(v)}>
                  {v}
                </Button>
              ))}
            </div>
            <FieldHint>
              Il tag dell&apos;immagine ufficiale. Sceglila uguale a quella che usi in sviluppo: un
              dump ripristinato su una major diversa è il modo classico per perdere un pomeriggio.
            </FieldHint>
          </div>
        </div>

        <div>
          <TextField value={port} onChange={setPort}>
            <Label>Porta sull&apos;host</Label>
            <Input type="number" />
          </TextField>
          <FieldHint>
            Serve a te, per collegarti dalla macchina con un client esterno. Se{" "}
            <Code>{option.defaultPort}</Code> è già occupata — un altro {option.label} installato,
            o un altro servizio qui dentro — cambiala pure: dentro la rete del progetto l&apos;app
            continua a usare la porta standard del container, quindi per lei non cambia nulla.
          </FieldHint>
        </div>
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader
          title="Credenziali"
          description="Lasciando vuoto, RunPanel genera una password casuale"
        />

        {option.credentialled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField value={user} onChange={setUser}>
              <Label>Utente</Label>
              <Input className="font-mono text-sm" />
            </TextField>
            <TextField value={database} onChange={setDatabase}>
              <Label>Database</Label>
              <Input className="font-mono text-sm" />
            </TextField>
          </div>
        )}

        <div>
          <TextField value={password} onChange={setPassword}>
            <Label>Password</Label>
            <Input type="password" placeholder="generata automaticamente" className="font-mono text-sm" />
          </TextField>
          <FieldHint>
            Lasciala vuota: viene generata casuale e non devi ricordartela, perché nell&apos;app
            arriva da sola. Resta cifrata a riposo e la puoi rileggere quando vuoi dalla pagina del
            servizio. Vale la pena metterla a mano solo se stai ricreando un servizio che deve
            ritrovare un volume con dati già inizializzati da quelle credenziali.
          </FieldHint>
        </div>
      </Panel>

      <div className="flex justify-end">
        <Button variant="primary" isPending={saving} onPress={create}>
          Crea servizio
        </Button>
      </div>
    </div>
  );
}
