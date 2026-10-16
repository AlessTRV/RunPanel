"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { CopyField } from "@/components/ui/CopyField";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { SelectField } from "@/components/ui/SelectField";
import { Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { formatRelative } from "@/lib/format";
import { TONE_DOT, type StatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { ClusterView, ClusterMemberView } from "@/app/api/cluster/route";
import type { MemberDiagnosis } from "@/app/api/cluster/members/[memberId]/diagnose/route";
import { ClusterOverview } from "@/components/ClusterOverview";

/**
 * The other RunPanel installs this one is linked with.
 *
 * Linking happens on the new server's first-run page with a token issued
 * here; everything after that — diagnosis, role, revocation, a new shared
 * secret — happens here and is replicated to every member.
 */

const STATUS: Record<ClusterMemberView["status"], { label: string; tone: StatusTone }> = {
  ok: { label: "Raggiungibile", tone: "success" },
  unreachable: { label: "Non raggiungibile", tone: "danger" },
  unknown: { label: "Mai contattato", tone: "neutral" },
};

const ROLE_LABEL = { panel: "Pannello", node: "Nodo" } as const;

const ROLE_OPTIONS = [
  { value: "panel" as const, label: "Pannello", description: "Mostra l'interfaccia e gestisce gli altri server" },
  { value: "node" as const, label: "Nodo", description: "Solo gestito: nessun accesso diretto" },
];

export default function ServersPage() {
  const { data, error, loading, refresh } = useResource<ClusterView>("/api/cluster", { intervalMs: usePollInterval(30_000) });
  const [issued, setIssued] = useState<{ token: string; panelUrl: string; expiresAt: string } | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<{ member: ClusterMemberView; result: MemberDiagnosis } | null>(null);
  const [roleTarget, setRoleTarget] = useState<ClusterMemberView | null>(null);
  const [role, setRole] = useState<"panel" | "node">("panel");
  const [revokeTarget, setRevokeTarget] = useState<ClusterMemberView | null>(null);
  const [rotateAfter, setRotateAfter] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function issueToken() {
    setIssuing(true);
    try {
      const res = await fetch("/api/cluster/link-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Impossibile generare il token");
        return;
      }
      setIssued(body);
      await refresh();
    } finally {
      setIssuing(false);
    }
  }

  async function diagnose(member: ClusterMemberView) {
    setBusy(member.id);
    try {
      const res = await fetch(`/api/cluster/members/${member.id}/diagnose`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Diagnosi non riuscita");
        return;
      }
      setDiagnosis({ member, result: body });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function resendSecret(member: ClusterMemberView) {
    setBusy(member.id);
    try {
      const res = await fetch(`/api/cluster/members/${member.id}/resend-secret`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Invio non riuscito");
        return;
      }
      toast.success(`Segreto reinviato a ${member.name}`);
      setDiagnosis(null);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function saveRole() {
    if (!roleTarget) return false;
    const res = await fetch(`/api/cluster/members/${roleTarget.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error || "Modifica non riuscita");
      return false;
    }
    toast.success(`${roleTarget.name} ora è ${ROLE_LABEL[role].toLowerCase()}`);
    await refresh();
    return true;
  }

  async function revoke() {
    if (!revokeTarget) return false;
    const res = await fetch(`/api/cluster/members/${revokeTarget.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error || "Revoca non riuscita");
      return false;
    }
    toast.success(body.told ? `${revokeTarget.name} scollegato` : `${revokeTarget.name} rimosso, ma non ha risposto: rigenera il segreto`);
    if (rotateAfter) await rotate();
    await refresh();
    return true;
  }

  async function rotate() {
    setRotating(true);
    try {
      const res = await fetch("/api/cluster/rotate-secret", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Rotazione non riuscita");
        return;
      }
      const failed = (body.members as { name: string; ok: boolean }[]).filter((m) => !m.ok);
      if (failed.length === 0) toast.success("Nuovo segreto installato su tutti i server");
      else toast.warning(`Nuovo segreto installato, ma non su: ${failed.map((m) => m.name).join(", ")}`);
      await refresh();
    } finally {
      setRotating(false);
    }
  }

  const members = data?.members ?? [];
  const others = members.filter((m) => !m.self);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Server"
        description="Gli altri RunPanel collegati a questo: stessi account, un solo pannello."
        actions={
          <div className="flex gap-2">
            {others.length > 0 && (
              <Button variant="ghost" size="sm" onPress={rotate} isPending={rotating}>
                <Icon icon="solar:key-linear" width={16} aria-hidden />
                Rigenera il segreto
              </Button>
            )}
            <Button variant="primary" size="sm" onPress={issueToken} isPending={issuing}>
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Collega un server
            </Button>
          </div>
        }
      />

      {error ? (
        <LoadError error={error} onRetry={refresh} what="i server" />
      ) : loading && !data ? (
        <SkeletonBlock className="h-40" />
      ) : members.length === 0 ? (
        <Panel>
          <EmptyState
            icon="solar:server-2-line-duotone"
            title="Nessun server collegato"
            description="Genera un token, poi aprilo nella pagina di primo avvio del nuovo server e scegli “Collega a un RunPanel”."
            action={
              <Button variant="primary" size="sm" onPress={issueToken} isPending={issuing}>
                Collega un server
              </Button>
            }
          />
        </Panel>
      ) : (
        <>
        <ClusterOverview interactive={false} className="mb-4" />
        <Panel padding="flush">
          <PanelHeader title="Membri del cluster" description={`${members.length} server, questo compreso`} className="px-4 pt-4" />
          <ul className="divide-border divide-y">
            {members.map((m) => {
              const status = STATUS[m.status];
              const versionMismatch = !m.self && m.version !== null && data?.selfVersion !== undefined && m.version !== data.selfVersion;
              return (
                <li key={m.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground font-medium">{m.name}</span>
                      {m.self && <span className="text-muted text-xs">(questo server)</span>}
                      <span className="bg-default text-muted rounded-md px-1.5 py-0.5 text-xs">{ROLE_LABEL[m.role]}</span>
                    </div>
                    <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="font-mono">{m.url}</span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} aria-hidden />
                        {status.label}
                      </span>
                      {!m.self && <span>visto {formatRelative(m.lastSeenAt)}</span>}
                      {m.version && (
                        <span className={cn("font-mono", versionMismatch && "text-warning")} title={versionMismatch ? `Questo pannello: ${data?.selfVersion}` : undefined}>
                          {m.version}
                          {versionMismatch ? " ≠" : ""}
                        </span>
                      )}
                    </div>
                    {m.lastError && <p className="text-danger text-xs">{m.lastError}</p>}
                  </div>
                  {!m.self && (
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button variant="ghost" size="sm" onPress={() => diagnose(m)} isPending={busy === m.id}>
                        Diagnostica
                      </Button>
                      {m.lastError && /401|Firma/.test(m.lastError) && (
                        <Button variant="ghost" size="sm" onPress={() => resendSecret(m)} isPending={busy === m.id}>
                          Reinvia il segreto
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => {
                          setRole(m.role);
                          setRoleTarget(m);
                        }}
                      >
                        Ruolo
                      </Button>
                      <Button variant="ghost" size="sm" className="text-danger" onPress={() => setRevokeTarget(m)}>
                        Revoca
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
        </>
      )}

      <FormDialog
        isOpen={issued !== null}
        onOpenChange={(open) => {
          if (!open) setIssued(null);
        }}
        title="Token di collegamento"
        description="Sul nuovo server, nella pagina di primo avvio, scegli “Collega a un RunPanel” e inserisci questi due valori."
        submitLabel="Fatto"
        onSubmit={() => setIssued(null)}
      >
        {issued && (
          <div className="space-y-3">
            <CopyField value={issued.panelUrl} label="Indirizzo del pannello" />
            <CopyField value={issued.token} label="Token" secret />
            <Hint tone="warn">Lo vedi solo ora. Vale un&apos;ora e una volta sola.</Hint>
          </div>
        )}
      </FormDialog>

      <FormDialog
        isOpen={diagnosis !== null}
        onOpenChange={(open) => {
          if (!open) setDiagnosis(null);
        }}
        title={diagnosis ? `Diagnosi di ${diagnosis.member.name}` : "Diagnosi"}
        submitLabel="Chiudi"
        onSubmit={() => setDiagnosis(null)}
      >
        {diagnosis && (
          <div className="space-y-4">
            <DiagnosisList result={diagnosis.result} selfVersion={data?.selfVersion ?? null} />
            {diagnosis.result.reachable && !diagnosis.result.signatureOk && (
              <Hint tone="warn">
                <p>
                  Il server non riconosce il segreto attuale: probabilmente era irraggiungibile durante l&apos;ultima
                  rotazione. Si può reinviare entro dieci minuti dalla rotazione; dopo va revocato e reinstallato.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onPress={() => resendSecret(diagnosis.member)}
                  isPending={busy === diagnosis.member.id}
                >
                  Reinvia il segreto
                </Button>
              </Hint>
            )}
          </div>
        )}
      </FormDialog>

      <FormDialog
        isOpen={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoleTarget(null);
        }}
        title={roleTarget ? `Ruolo di ${roleTarget.name}` : "Ruolo"}
        description="Un nodo non ha accesso proprio: chi lo apre viene rimandato ai pannelli."
        onSubmit={saveRole}
      >
        <SelectField label="Ruolo" value={role} onChange={setRole} options={ROLE_OPTIONS} />
      </FormDialog>

      <ConfirmDialog
        isOpen={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={revokeTarget ? `Revocare ${revokeTarget.name}?` : "Revocare?"}
        description={
          <div className="space-y-3">
            <p>
              Il server viene scollegato e torna indipendente, con una copia degli account. I suoi progetti restano dove sono.
            </p>
            <CheckboxField
              label="Rigenera anche il segreto condiviso"
              description="Consigliato: il server revocato conosce quello attuale."
              isSelected={rotateAfter}
              onChange={setRotateAfter}
            />
          </div>
        }
        confirmLabel="Revoca"
        destructive
        onConfirm={revoke}
      />
    </div>
  );
}

function DiagnosisList({ result, selfVersion }: { result: MemberDiagnosis; selfVersion: string | null }) {
  const rows: { label: string; ok: boolean | null; detail: string }[] = [
    { label: "Raggiungibile", ok: result.reachable, detail: result.error ?? "Risponde" },
    { label: "Stesso segreto", ok: result.signatureOk, detail: result.signatureOk ? "Firma accettata" : "Firma rifiutata: rigenera il segreto e ricollega" },
    { label: "Stesso cluster", ok: result.sameCluster, detail: result.sameCluster ? "Stesso id di cluster" : "Appartiene a un altro cluster" },
    {
      label: "Versione",
      ok: result.versionMatch,
      detail: result.version ? `${result.version}${result.versionMatch === false ? ` (qui ${selfVersion})` : ""}` : "Sconosciuta",
    },
    {
      label: "Orologio",
      ok: result.skewOk,
      detail: result.skewMs === null ? "Non misurato" : `${result.skewMs >= 0 ? "+" : ""}${(result.skewMs / 1000).toFixed(1)} s rispetto a questo pannello`,
    },
    { label: "Directory allineata", ok: result.directoryMatch, detail: result.directoryMatch ? "Stessi account e membri" : "Differenze: la sincronizzazione le risolve al prossimo giro" },
  ];
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="flex items-start gap-2.5 text-sm">
          <Icon
            icon={row.ok === null ? "solar:info-circle-linear" : row.ok ? "solar:check-circle-linear" : "solar:close-circle-linear"}
            width={18}
            className={cn("mt-0.5 shrink-0", row.ok === null ? "text-muted" : row.ok ? "text-success" : "text-danger")}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="text-foreground font-medium">{row.label}</div>
            <div className="text-muted text-xs">{row.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
