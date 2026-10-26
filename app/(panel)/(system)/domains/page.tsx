"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { formatWhen } from "@/lib/format";
import { TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";
import { DOMAIN_RULE, domainNameSchema } from "@/lib/validation";
import type { ProxyProbe } from "@/services/proxy/host";
import type { HostView } from "@/services/proxy";
import { HOST_STATUS } from "@/lib/host-status";

/**
 * Domains this server's nginx answers for, and every name assigned under them.
 *
 * The page leads with whether nginx can take a configuration at all, because
 * nothing below it works until it can — and, when it cannot, with exactly what
 * to do about it, the way the autostart page does.
 */

interface DomainsData {
  proxy: ProxyProbe;
  acmeEmail: string;
  addresses: string[];
  cloudflare: {
    connected: boolean;
    zones: { id: string; name: string; status: string; domainId: string | null }[];
    error: string | null;
  };
  domains: { id: string; name: string; cloudflare: boolean; hostCount: number; created_at: string }[];
  hosts: HostView[];
}

const READY_STATES = new Set(["ready", "no-certbot"]);

export default function DomainsPage() {
  const api = useNodeApi();
  const href = useServerHref();
  const poll = usePollInterval(10000);
  const { data, loading, error, refresh } = useResource<DomainsData>(api("/api/domains"), {
    intervalMs: poll,
    refreshUrl: api("/api/domains?fresh=1"),
  });

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [commands, setCommands] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<DomainsData["domains"][number] | null>(null);
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);

  // The field shows what is stored until the operator types; then it is theirs.
  const emailValue = email ?? data?.acmeEmail ?? "";

  async function send(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(api(path), { headers: { "Content-Type": "application/json" }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !body.commands) {
        toast.error(body.details?.[0]?.message ?? body.error ?? body.message ?? MSG.saveFailed);
        return null;
      }
      return body;
    } catch {
      toast.error(MSG.unreachable);
      return null;
    }
  }

  async function addDomain() {
    const parsed = domainNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? DOMAIN_RULE);
      return;
    }
    setBusy("add");
    const body = await send("/api/domains", { method: "POST", body: JSON.stringify({ name: parsed.data }) });
    setBusy(null);
    if (!body) return;
    toast.success(`${parsed.data} aggiunto`);
    setName("");
    setNameError(null);
    await refresh();
  }

  /** One of the Cloudflare account's zones, added as it is. */
  async function addZone(zone: string) {
    setBusy(`zone:${zone}`);
    const body = await send("/api/domains", { method: "POST", body: JSON.stringify({ name: zone }) });
    setBusy(null);
    if (!body) return;
    toast.success(`${zone} aggiunto`);
    await refresh();
  }

  async function connectCloudflare() {
    setBusy("cloudflare");
    const body = await send("/api/domains/cloudflare", {
      method: "PUT",
      body: JSON.stringify({ token: cloudflareToken }),
    });
    setBusy(null);
    if (!body) return;
    toast.success("Cloudflare collegato");
    setCloudflareToken("");
    await refresh();
  }

  async function disconnectCloudflare(): Promise<boolean> {
    const body = await send("/api/domains/cloudflare", { method: "DELETE" });
    if (!body) return false;
    toast.success("Cloudflare scollegato");
    await refresh();
    return true;
  }

  async function proxyAction(action: "setup" | "apply") {
    setBusy(action);
    const body = await send("/api/domains/proxy", { method: "POST", body: JSON.stringify({ action }) });
    setBusy(null);
    if (!body) return;
    if (Array.isArray(body.commands) && body.commands.length > 0) {
      setCommands(body.commands as string[]);
    } else if (body.ok) {
      const requested = Number(body.requested ?? 0);
      toast.success(
        requested > 0 ? `${body.message} Richiesti ${requested} certificati.` : String(body.message ?? "Fatto")
      );
      setCommands(null);
    } else {
      toast.error(String(body.message ?? "Operazione non riuscita"));
    }
    await refresh();
  }

  async function saveEmail() {
    setBusy("email");
    const body = await send("/api/domains/settings", { method: "PUT", body: JSON.stringify({ acmeEmail: emailValue }) });
    setBusy(null);
    if (body) toast.success("Email salvata");
  }

  async function removeDomain(): Promise<boolean> {
    if (!removing) return true;
    const body = await send(`/api/domains/${removing.id}`, { method: "DELETE" });
    if (!body) return false;
    toast.success(`${removing.name} rimosso`);
    await refresh();
    return true;
  }

  if (!data && error) {
    return (
      <>
        <PageHeader title="Domini" />
        <LoadError what="i domini" error={error} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Domini" />
        <div className="space-y-4">
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-56" />
        </div>
      </>
    );
  }

  const proxy = data?.proxy;
  const cloudflare = data?.cloudflare;
  const ready = proxy ? READY_STATES.has(proxy.state) : false;
  // A root panel gets a button instead, and the commands only if /etc turned out read-only.
  const shownCommands =
    commands ?? (!proxy?.root && (proxy?.state === "not-configured" || proxy?.state === "no-reload") ? proxy.commands : null);
  const target = data?.addresses.length ? data.addresses.join(" / ") : "l'IP pubblico di questo server";

  return (
    <>
      <PageHeader
        title="Domini"
        description="Un sottodominio HTTPS per ogni progetto, servito dal tuo nginx"
        actions={
          ready ? (
            <Button size="sm" variant="secondary" onPress={() => proxyAction("apply")} isPending={busy === "apply"}>
              <Icon icon="solar:refresh-linear" width={16} aria-hidden />
              Riapplica a nginx
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title={ready ? "nginx è pronto" : "nginx non è ancora pronto"}
            description={proxy?.detail}
            actions={
              proxy?.state === "not-configured" || proxy?.state === "no-reload" ? (
                proxy.root ? (
                  <Button size="sm" onPress={() => proxyAction("setup")} isPending={busy === "setup"}>
                    <Icon icon="solar:shield-check-linear" width={16} aria-hidden />
                    Configura
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onPress={() => proxyAction("apply")} isPending={busy === "apply"}>
                    Ho eseguito i comandi
                  </Button>
                )
              ) : undefined
            }
          />

          {shownCommands && shownCommands.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-muted text-xs">
                Una volta sola, in un terminale sul server. Il pannello potrà scrivere solo in{" "}
                <Code>/var/lib/runpanel-proxy</Code>
                {proxy?.reload === "systemd" ? (
                  <>
                    {" "}e chiedere a systemd, con due path unit, di eseguire <Code>nginx -t</Code> e{" "}
                    <Code>nginx -s reload</Code>
                  </>
                ) : proxy?.reload === "sudo" ? (
                  <>
                    {" "}e lanciare con sudo solo <Code>nginx -t</Code> e <Code>nginx -s reload</Code>
                  </>
                ) : null}
                : i tuoi server block non vengono toccati.
              </p>
              <CommandBlock commands={shownCommands} />
            </div>
          )}

          {proxy?.state === "no-nginx" && (
            <Hint className="mt-4" title="Installa nginx">
              Per esempio <Code>sudo apt install nginx</Code>, poi torna qui.
            </Hint>
          )}
          {proxy?.state === "no-certbot" && (
            <Hint tone="warn" className="mt-4" title="Manca certbot">
              Senza certbot i nomi funzionano solo in HTTP. Installalo (per esempio{" "}
              <Code>sudo apt install certbot</Code>) e premi Riapplica: i certificati in attesa vengono
              richiesti da soli.
            </Hint>
          )}

          {proxy && (proxy.nginx.version || proxy.certbot.version) && (
            <dl className="text-muted mt-4 grid gap-1 text-xs sm:grid-cols-2">
              <div>
                <dt className="inline">nginx: </dt>
                <dd className="inline font-mono">{proxy.nginx.version ?? "non trovato"}</dd>
              </div>
              <div>
                <dt className="inline">certbot: </dt>
                <dd className="inline font-mono">{proxy.certbot.version ?? "non trovato"}</dd>
              </div>
            </dl>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Domini" description="Quelli di cui questo server serve i sottodomini" />
          <div className="mt-4 space-y-4">
            {(data?.domains.length ?? 0) === 0 ? (
              <EmptyState
                icon="solar:global-linear"
                title="Nessun dominio"
                description="Aggiungi un dominio che possiedi: ogni progetto potrà averne un sottodominio."
                className="py-6"
              />
            ) : (
              <ul className="divide-border divide-y">
                {data?.domains.map((domain) => (
                  <li key={domain.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-center gap-2">
                        <span className="text-foreground font-mono text-sm">{domain.name}</span>
                        {domain.cloudflare && (
                          <span className="bg-surface-secondary text-muted text-meta rounded px-1.5 py-0.5">
                            Cloudflare
                          </span>
                        )}
                      </p>
                      <p className="text-muted text-xs">
                        Record DNS: <Code>*.{domain.name}</Code> → {target}
                        {" · "}
                        {domain.hostCount === 0
                          ? "nessun sottodominio"
                          : domain.hostCount === 1
                            ? "1 sottodominio"
                            : `${domain.hostCount} sottodomini`}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="text-danger shrink-0" onPress={() => setRemoving(domain)}>
                      <Icon icon="solar:trash-bin-trash-linear" width={16} aria-hidden />
                      Rimuovi
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <Field label="Nuovo dominio" hint={DOMAIN_RULE} error={nameError ?? undefined} className="flex-1">
                <TextField
                  value={name}
                  onChange={(value) => {
                    setName(value);
                    setNameError(null);
                  }}
                  aria-label="Nuovo dominio"
                >
                  <Input placeholder="esempio.it" className="font-mono" />
                </TextField>
              </Field>
              <Button size="sm" className="sm:mt-7" onPress={addDomain} isPending={busy === "add"} isDisabled={!name.trim()}>
                <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                Aggiungi
              </Button>
            </div>
            <FieldHint>
              Prima di assegnare un nome, crea presso il tuo provider DNS un record <Code>A</Code> (e{" "}
              <Code>AAAA</Code> se hai IPv6) per <Code>*.dominio</Code> che punti a questo server. Un solo
              record copre tutti i sottodomini.
            </FieldHint>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title={cloudflare?.connected ? "Cloudflare collegato" : "Cloudflare"}
            description={
              cloudflare?.connected
                ? "I domini che il token vede: i loro certificati passano dal DNS, anche con il proxy attivo"
                : "Facoltativo: con un API token i certificati passano dal DNS di Cloudflare, e qui vedi i tuoi domini"
            }
            actions={
              cloudflare?.connected ? (
                <Button variant="ghost" size="sm" className="text-danger" onPress={() => setDisconnecting(true)}>
                  Scollega
                </Button>
              ) : undefined
            }
          />
          {cloudflare?.connected ? (
            <div className="mt-4 space-y-4">
              {cloudflare.error ? (
                <p className="text-danger text-sm">{cloudflare.error}</p>
              ) : cloudflare.zones.length === 0 ? (
                <p className="text-muted text-sm">
                  Il token non vede nessun dominio: gli serve il permesso Zone · Zone · Read.
                </p>
              ) : (
                <ul className="divide-border divide-y">
                  {cloudflare.zones.map((zone) => (
                    <li key={zone.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-foreground truncate font-mono text-sm">{zone.name}</p>
                        {zone.status !== "active" && (
                          <p className="text-muted text-xs">
                            In attesa su Cloudflare: finché i nameserver non puntano lì, i certificati passano dalla
                            porta 80
                          </p>
                        )}
                      </div>
                      {zone.domainId ? (
                        <span className="text-muted shrink-0 text-xs">Aggiunto</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="shrink-0"
                          onPress={() => addZone(zone.name)}
                          isPending={busy === `zone:${zone.name}`}
                        >
                          <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                          Aggiungi
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <Hint title="Con la nuvola arancione">
                In Cloudflare metti SSL/TLS su <strong className="text-foreground">Full (strict)</strong>: con Flexible
                il redirect a HTTPS gira in tondo. nginx prende l&apos;indirizzo del visitatore da{" "}
                <Code>CF-Connecting-IP</Code>, e solo dalle connessioni che arrivano da Cloudflare, così le regole di
                accesso dei progetti continuano a valere.
              </Hint>
            </div>
          ) : (
            <div className="mt-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <TextField
                  type="password"
                  value={cloudflareToken}
                  onChange={setCloudflareToken}
                  aria-label="API token di Cloudflare"
                  className="flex-1"
                >
                  <Input placeholder="API token" className="font-mono text-sm" />
                </TextField>
                <Button
                  size="sm"
                  onPress={connectCloudflare}
                  isPending={busy === "cloudflare"}
                  isDisabled={!cloudflareToken.trim()}
                >
                  <Icon icon="solar:link-round-linear" width={16} aria-hidden />
                  Collega
                </Button>
              </div>
              <FieldHint>
                Su Cloudflare: My Profile › API Tokens › Create Token, con i permessi{" "}
                <strong className="text-foreground">Zone · Zone · Read</strong> e{" "}
                <strong className="text-foreground">Zone · DNS · Edit</strong>. Viene cifrato nel pannello e passato a
                certbot solo per pubblicare il record della verifica.
              </FieldHint>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Email per Let's Encrypt"
            description="Facoltativa: è il contatto dell'account. I rinnovi li fa il pannello, e le scadenze sono qui sotto"
          />
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
            <TextField value={emailValue} onChange={setEmail} aria-label="Email per Let's Encrypt" className="flex-1">
              <Input type="email" placeholder="tu@esempio.it" />
            </TextField>
            <Button size="sm" variant="secondary" onPress={saveEmail} isPending={busy === "email"}>
              <Icon icon="solar:diskette-linear" width={16} aria-hidden />
              Salva
            </Button>
          </div>
        </Panel>

        <Panel padding="flush">
          <PanelHeader
            title="Sottodomini assegnati"
            description="Si assegnano dalle impostazioni di ogni progetto"
            className="px-4 pt-4"
          />
          {(data?.hosts.length ?? 0) === 0 ? (
            <EmptyState
              icon="solar:link-round-linear"
              title="Nessun sottodominio"
              description="Apri un progetto, Impostazioni › Dominio."
              className="py-8"
            />
          ) : (
            <ul className="divide-border mt-2 divide-y">
              {data?.hosts.map((host) => {
                const status = HOST_STATUS[host.status] ?? HOST_STATUS.pending;
                return (
                  <li key={host.id} className="flex flex-col gap-1 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <a
                        href={`${host.status === "active" ? "https" : "http"}://${host.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground font-mono text-sm hover:underline"
                      >
                        {host.hostname}
                      </a>
                      <span className="text-muted inline-flex items-center gap-1.5 text-xs">
                        <span className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} aria-hidden />
                        {status.label}
                      </span>
                      {host.certExpiresAt && (
                        <span className="text-muted text-xs">scade {formatWhen(host.certExpiresAt)}</span>
                      )}
                      <Link
                        href={href(`/projects/${host.projectId}/settings`)}
                        className="text-muted hover:text-foreground text-xs"
                      >
                        {host.projectName}
                      </Link>
                    </div>
                    {host.applyError && <p className="text-danger text-xs">{host.applyError}</p>}
                    {host.lastError && host.status === "error" && <p className="text-danger text-xs">{host.lastError}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Rimuovere ${removing?.name ?? ""}?`}
        description="Il dominio sparisce dalla lista. Si può togliere solo quando nessun progetto ne usa un sottodominio."
        confirmLabel="Rimuovi"
        destructive
        onConfirm={removeDomain}
      />

      <ConfirmDialog
        isOpen={disconnecting}
        onOpenChange={(open) => !open && setDisconnecting(false)}
        title="Scollegare Cloudflare?"
        description="Il token viene cancellato dal pannello. I certificati già emessi restano, ma ai rinnovi i loro nomi tornano alla verifica sulla porta 80, che dietro il proxy di Cloudflare non passa."
        confirmLabel="Scollega"
        destructive
        onConfirm={disconnectCloudflare}
      />
    </>
  );
}
