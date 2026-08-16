"use client";

import { useCallback, useState } from "react";
import { Button } from "@heroui/react";
import { toast } from "sonner";
import { Section } from "@/components/ui/Section";
import { CopyField } from "@/components/ui/CopyField";
import { CheckList, type Check } from "@/components/ui/CheckList";
import { Segmented } from "@/components/ui/Segmented";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Code, FieldHint } from "@/components/ui/Hint";
import { formatRelative } from "@/lib/format";
import { MSG } from "@/lib/copy";
import type { Project } from "./types";

/**
 * Auto-deploy, and whether it is actually going to happen.
 *
 * This section used to be a URL, a secret and a paragraph of instructions. The
 * panel said everything it knew — which was nothing about whether any of it had
 * been done, or worked. A push that never arrived and a push that arrived and
 * was refused looked identical from here: silence.
 *
 * So the section now answers the question it is about. The checks come from the
 * server, which is the only side that can ask GitHub, and the copy fields stay
 * for the case that is still manual — no token connected, or a repository the
 * token cannot administer.
 */

interface PanelDelivery {
  id: string;
  status: string;
  receivedAt: string;
  deploymentId: string | null;
  summary: Record<string, unknown>;
}

interface GithubDelivery {
  id: string;
  event: string;
  deliveredAt: string;
  redelivery: boolean;
  status: string;
  statusCode: number | null;
}

interface WebhookStatus {
  autoDeploy: boolean;
  trigger: "webhook" | "poll";
  poll: {
    intervalSeconds: number;
    intervalLabel: string;
    lastCheckedAt: string | null;
    sha: string | null;
  };
  repo: string | null;
  connected: boolean;
  baseUrl: {
    origin: string;
    source: "setting" | "request";
    reachable: boolean;
    tailnet: boolean;
    host: string;
  } | null;
  url: string | null;
  hook: { id: string; active: boolean; contentType: string; events: string[] } | null;
  hookError: string | null;
  deliveries: PanelDelivery[];
  githubDeliveries: GithubDelivery[];
  checks: Check[];
}

const DELIVERY_TONE: Record<string, string> = {
  accepted: "text-success",
  ignored: "text-muted",
  rejected: "text-danger",
};

const DELIVERY_LABEL: Record<string, string> = {
  accepted: "accettata",
  ignored: "ignorata",
  rejected: "rifiutata",
};

/** The reason a delivery did not deploy, as the receiver recorded it. */
function deliveryDetail(delivery: PanelDelivery): string {
  const { summary } = delivery;
  const event = typeof summary.event === "string" ? summary.event : "?";
  const reason = typeof summary.reason === "string" ? summary.reason : null;
  const commit = typeof summary.head_commit === "string" ? summary.head_commit : null;

  if (reason) return `${event} — ${reason}`;
  if (commit) return `${event} — ${commit}`;
  return event;
}

export function WebhookSection({
  project,
  onProjectChange,
}: {
  project: Project;
  onProjectChange: (project: Project) => void;
}) {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /*
    Nothing is fetched until the section is opened. Reading this status costs
    two or three calls to the GitHub API against an hourly budget, and the
    settings tab is opened to change a start command far more often than to ask
    about a webhook.
  */
  const [opened, setOpened] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/webhook`);
      if (res.ok) setStatus(await res.json());
    } catch {
      /* The checks are a diagnostic; failing to fetch them is not worth a toast. */
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  /** Opening the section is the event that pays for the status, so it asks. */
  function handleExpanded(expanded: boolean) {
    setOpened(expanded);
    if (expanded && !status && !loading) void load();
  }

  async function act(action: "connect" | "ping" | "disconnect", label: string) {
    setBusy(action);
    try {
      const res = await fetch(`/api/projects/${project.id}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      // Both answers carry a freshly computed status, so the panel re-renders
      // from what the server just saw rather than from a follow-up that races it.
      if (data.status) setStatus(data.status);
      if (res.ok) toast.success(data.message ?? label);
      else toast.error(data.error ?? MSG.updateFailed);
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
  }

  /** Both switches in this section write the same row, so they save the same way. */
  async function patch(body: Record<string, unknown>, done: string) {
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error();

      if (typeof body.autoDeploy === "boolean") {
        onProjectChange({ ...project, auto_deploy: body.autoDeploy ? 1 : 0 });
      }
      toast.success(done);

      // The columns are saved either way; GitHub may still have refused the hook.
      if (data.webhookWarning) toast.warning(data.webhookWarning);

      if (opened) void load();
    } catch {
      toast.error(MSG.updateFailed);
    }
  }

  const toggleAutoDeploy = (enabled: boolean) =>
    patch({ autoDeploy: enabled }, enabled ? "Auto-deploy attivo" : "Auto-deploy disattivato");

  const setTrigger = (trigger: string) =>
    patch(
      { deployTrigger: trigger },
      trigger === "poll" ? "RunPanel controllerà il branch" : "GitHub avviserà RunPanel"
    );

  const polling = status?.trigger === "poll";
  const hookReady = Boolean(status?.hook?.active);
  const manual = status ? !status.connected || !status.repo : false;

  /*
    A closed section has to answer its own question — "Deploy automatico" alone
    is a label, not an answer. Before the status is loaded it says what the flag
    says, which is all the panel knows without asking GitHub.
  */
  const summary = project.pinned_sha
    ? // Ahead of every other branch: while the project is held at a commit
      // nothing here fires, and a summary reading "Attivo" over an auto-deploy
      // that will not run is the one sentence this line must never say.
      `Sospeso: progetto fermo su ${project.pinned_sha.slice(0, 7)}`
    : !project.auto_deploy
    ? "Spento: si distribuisce dal pulsante Deploy"
    : !status
      ? "Attivo: ogni push sul branch fa partire un deploy"
      : polling
        ? `Attivo · controllo ogni ${status.poll.intervalLabel}${
            status.poll.lastCheckedAt ? ` · ${formatRelative(status.poll.lastCheckedAt)}` : ""
          }`
        : hookReady
          ? `Attivo · webhook collegato${
              status.deliveries[0] ? ` · ultima consegna ${formatRelative(status.deliveries[0].receivedAt)}` : ""
            }`
          : manual
            ? "Attivo · webhook da configurare a mano su GitHub"
            : "Attivo · webhook non collegato";

  return (
    <Section
      title="Deploy automatico"
      summary={summary}
      onExpandedChange={handleExpanded}
      actions={
        <SettingToggle
          label="Attiva auto-deploy"
          isSelected={Boolean(project.auto_deploy)}
          onChange={toggleAutoDeploy}
          className="w-auto"
        />
      }
    >
      {/*
        Which direction the news travels, stated before anything else in the
        section: everything below reads differently depending on the answer, and
        a panel behind NAT or on a VPN has only one of the two available to it.
      */}
      {status && project.source_type === "github" && (
        <div>
          <span className="text-muted mb-2 block text-sm font-medium">Come parte il deploy</span>
          <Segmented
            label="Come parte il deploy"
            value={status.trigger}
            onChange={setTrigger}
            options={[
              { value: "webhook", label: "Webhook", icon: "solar:bolt-linear" },
              { value: "poll", label: "Controllo periodico", icon: "solar:refresh-linear" },
            ]}
          />
          <FieldHint>
            {polling
              ? `RunPanel guarda il branch ogni ${status.poll.intervalLabel} e distribuisce quando il commit cambia. Non serve che GitHub raggiunga il pannello: è la scelta giusta dietro NAT, VPN o Tailscale. Il ritardo massimo è un intervallo, che si cambia nelle preferenze dell'account.`
              : "GitHub avvisa RunPanel a ogni push, e il deploy parte subito. Richiede che il pannello sia raggiungibile da internet."}
          </FieldHint>
        </div>
      )}

      {status && status.checks.length > 0 && <CheckList checks={status.checks} onChanged={load} />}

      {status && !polling && !manual && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            isPending={busy === "connect"}
            onPress={() => void act("connect", "Webhook collegato")}
          >
            {status.hook ? "Riallinea webhook" : "Collega webhook"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!status.hook}
            isPending={busy === "ping"}
            onPress={() => void act("ping", "Ping inviato")}
          >
            Invia ping
          </Button>
          {status.hook?.active && (
            <Button
              size="sm"
              variant="ghost"
              isPending={busy === "disconnect"}
              onPress={() => void act("disconnect", "Webhook disattivato")}
            >
              Scollega
            </Button>
          )}
        </div>
      )}

      {/*
        Kept, and not only as a fallback: the secret is the one value that has
        to be re-entered by hand if the hook is ever rebuilt outside the panel,
        and a project restored from a backup comes back without it on GitHub.

        Hidden under polling, where there is no hook for either value to belong
        to — a URL nobody calls and a secret nothing signs are two more things
        to wonder about.
      */}
      {!polling && (
        <>
          <CopyField label="URL" value={status?.url ?? ""} />
          <CopyField label="Secret" value={project.webhook_secret} secret />
        </>
      )}

      {!polling && manual && (
        <FieldHint>
          Su GitHub: Repository → Settings → Webhooks → Add webhook. Content type{" "}
          <Code>application/json</Code>, e lascia selezionato il solo evento <Code>push</Code>. Una
          firma sbagliata viene rifiutata, quindi un Secret errato non fa danni.
        </FieldHint>
      )}

      {status && !polling && (status.deliveries.length > 0 || status.githubDeliveries.length > 0) && (
        <div className="space-y-3">
          {status.deliveries.length > 0 && (
            <div>
              <p className="text-muted mb-1.5 text-xs font-medium">Consegne ricevute</p>
              <ul className="divide-border divide-y text-xs">
                {status.deliveries.map((delivery) => (
                  <li key={delivery.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-muted min-w-0 flex-1 truncate">
                      {deliveryDetail(delivery)}
                    </span>
                    <span className={DELIVERY_TONE[delivery.status] ?? "text-muted"}>
                      {DELIVERY_LABEL[delivery.status] ?? delivery.status}
                    </span>
                    <span className="text-muted shrink-0">
                      {formatRelative(delivery.receivedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {status.githubDeliveries.length > 0 && (
            <div>
              <p className="text-muted mb-1.5 text-xs font-medium">Consegne viste da GitHub</p>
              {/*
                Both lists, because they answer different questions. A delivery
                GitHub records as a timeout never reached this process, so it
                cannot appear above — and that gap is the diagnosis.
              */}
              <ul className="divide-border divide-y text-xs">
                {status.githubDeliveries.map((delivery) => (
                  <li key={delivery.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-muted min-w-0 flex-1 truncate">
                      {delivery.event}
                      {delivery.redelivery && " (rinviata)"}
                    </span>
                    <span
                      className={
                        delivery.statusCode && delivery.statusCode >= 200 && delivery.statusCode < 300
                          ? "text-success"
                          : "text-danger"
                      }
                    >
                      {delivery.statusCode ?? delivery.status}
                    </span>
                    <span className="text-muted shrink-0">
                      {formatRelative(delivery.deliveredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {loading && !status && <p className="text-muted text-xs">Controllo su GitHub…</p>}
    </Section>
  );
}
