"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel } from "@/components/ui/Panel";
import { Code } from "@/components/ui/Hint";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { StatusBadge } from "@/components/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { serviceEnvKey, serviceLabel } from "@/lib/service-env";
import { serviceDisplayName } from "@/lib/service-name";

/**
 * A database attached to a project, and what that attachment does.
 *
 * The row this replaces was a single `<Link>` wrapping the whole thing, with a
 * caption on the right that read "sovrascritta: qui sotto c'è la tua" as soon
 * as a variable of the same name existed in the editor. Three problems in one
 * line: the caption was computed from the key being present while the deploy
 * checked whether its value was truthy, so the two disagreed for an empty
 * variable; it appeared while a key was still being typed, before anything was
 * saved; and being a link, there was nowhere to put a control, so the behaviour
 * it described could be read but never changed.
 *
 * Now the state IS the control. What the panel says here is what the pipeline
 * does, because both read the same flag.
 */

export interface LinkedServiceView {
  id: string;
  name: string;
  type: string;
  status: string;
  env_key?: string | null;
  inject_env?: number | null;
  /**
   * The host the deploy will write into the variable, resolved by the API
   * from the project's runtime: a container name on the project network for
   * a Docker or Compose project, `localhost` and the published port for a
   * native one.
   */
  injection?: { from: "host" | "container"; host: string; port: number; network: string | null } | null;
}

export function ServiceLink({
  service,
  /** Keys currently in the env editor — used to warn about the one that loses. */
  projectKeys,
  onChanged,
}: {
  service: LinkedServiceView;
  projectKeys: readonly string[];
  onChanged: () => void;
}) {
  const [injecting, setInjecting] = useState(service.inject_env === 1);
  const [pending, setPending] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const envKey = serviceEnvKey(service);
  const alsoDefined = projectKeys.some((key) => key.trim() === envKey);

  async function patch(body: Record<string, unknown>, failure: string) {
    const res = await fetch(`/api/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? failure);
    }
    return res.json();
  }

  async function toggle(next: boolean) {
    // Optimistic, then reverted on failure — the switch has to answer the press
    // immediately or it feels broken, and the request is a single column write.
    setInjecting(next);
    setPending(true);
    try {
      await patch({ injectEnv: next }, "Modifica non riuscita");
      onChanged();
    } catch (err) {
      setInjecting(!next);
      toast.error(err instanceof Error ? err.message : "Modifica non riuscita");
    } finally {
      setPending(false);
    }
  }

  async function unlink() {
    await patch({ projectId: null }, "Scollegamento non riuscito");
    toast.success(`${serviceDisplayName(service)} scollegato`);
    onChanged();
  }

  return (
    <Panel nested padding="compact" className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon
          icon={service.type === "redis" ? "solar:bolt-linear" : "solar:database-linear"}
          width={16}
          className="text-muted shrink-0"
          aria-hidden
        />
        <Link
          href={`/services/${service.id}`}
          className="text-foreground hover:text-accent min-w-0 truncate text-sm transition-colors"
        >
          {serviceDisplayName(service)}
        </Link>
        <span className="text-muted text-meta">{serviceLabel(service.type)}</span>
        <span className="ml-auto shrink-0">
          <StatusBadge status={service.status} />
        </span>
      </div>

      <SettingToggle
        label="Inietta variabili"
        isSelected={injecting}
        isDisabled={pending}
        onChange={(next) => void toggle(next)}
      />

      {injecting && (
        <div className="text-muted space-y-1 text-meta">
          <p className="flex items-center gap-1.5">
            <span aria-hidden>└</span>
            <Code>{envKey}</Code>
          </p>
          {service.injection && (
            // The host the app will actually receive. Printed here because a
            // `localhost` handed to a container, or a container name handed to
            // a PM2 process, is the whole reason a database "cannot be
            // reached" — and it used to be visible only in a deploy log.
            <p className="flex flex-wrap items-center gap-1.5 pl-4">
              <span aria-hidden>→</span>
              <Code>
                {service.injection.host}:{String(service.injection.port)}
              </Code>
              <span>
                {service.injection.network
                  ? `(rete ${service.injection.network})`
                  : "(dall'host, porta pubblicata)"}
              </span>
            </p>
          )}
        </div>
      )}

      <p className={`text-meta leading-relaxed ${statusTone(injecting, service.status, alsoDefined)}`}>
        {statusLine(injecting, service.status, alsoDefined, envKey)}
      </p>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onPress={() => setUnlinking(true)}>
          Scollega
        </Button>
      </div>

      <ConfirmDialog
        isOpen={unlinking}
        onOpenChange={setUnlinking}
        title={`Scollegare ${serviceDisplayName(service)}?`}
        description={
          <>
            Il servizio e i suoi dati restano. Dal prossimo deploy il progetto non riceve più{" "}
            <Code>{envKey}</Code>.
          </>
        }
        confirmLabel="Scollega"
        onConfirm={unlink}
      />
    </Panel>
  );
}

function statusTone(injecting: boolean, status: string, alsoDefined: boolean): string {
  if (!injecting) return "text-muted";
  if (status !== "running" || alsoDefined) return "text-warning";
  return "text-muted";
}

/**
 * One line, four states. Each one is checkable against what the deploy will
 * actually do — which is the whole reason the old caption had to go.
 */
function statusLine(
  injecting: boolean,
  status: string,
  alsoDefined: boolean,
  envKey: string
): string {
  if (!injecting) return "Spento: il progetto usa le variabili che hai definito tu.";
  if (alsoDefined) return `${envKey} è definita anche qui sotto: al deploy vince questa.`;
  if (status !== "running") return "Servizio fermo: avvialo prima del prossimo deploy.";
  return `Il progetto riceve ${envKey} al prossimo deploy.`;
}
