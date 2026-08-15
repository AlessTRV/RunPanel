"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Section } from "@/components/ui/Section";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { InfoTip } from "@/components/ui/Tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatRelative } from "@/lib/format";
import { IP_RULE_EVERYTHING, IP_RULE_HINT } from "@/lib/validation";
import { MSG } from "@/lib/copy";
import { cn } from "@/lib/utils";

/**
 * Who may reach a published port.
 *
 * One component for databases and for projects, because it is one question. The
 * pieces that differ — what a restart costs, what stops working — arrive as
 * props rather than as a second copy of the screen.
 *
 * The suggestions are the point. A port is restricted by naming networks in
 * CIDR, which is both easy to get wrong and unforgiving when you do: the way it
 * fails is that the operator can no longer reach their own database, from a
 * screen that offers no clue why. So the panel reads the host's interfaces and
 * offers them as tick boxes, and the gate remembers who it turned away.
 */

export type AccessMode = "open" | "restricted";

export interface AccessValue {
  mode: AccessMode;
  allow: string[];
  port: number | null;
}

export interface GateValue {
  running: boolean;
  publicPort: number | null;
  targetPort: number | null;
  rejections: { address: string; attempts: number; lastAt: string }[];
  leakingFrom: string | null;
}

interface SuggestedNetwork {
  cidr: string;
  iface: string;
  label: string;
  kind: "lan" | "vpn" | "virtual";
  address: string;
}

const KIND_LABEL: Record<SuggestedNetwork["kind"], string> = {
  lan: "rete locale",
  vpn: "VPN",
  virtual: "virtuale",
};

/** Mirrors `accessRuleSchema`, so a bad rule costs no round trip. */
function ruleError(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/\/0\s*$/.test(trimmed)) return IP_RULE_EVERYTHING;

  const [address, prefix] = trimmed.split("/");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const looksV6 = address.includes(":") && /^[0-9a-f:.]+$/i.test(address);

  if (v4) {
    if (v4.slice(1).some((octet) => Number(octet) > 255 || (octet.length > 1 && octet.startsWith("0")))) {
      return IP_RULE_HINT;
    }
  } else if (!looksV6) {
    return IP_RULE_HINT;
  }

  if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (v4 ? 32 : 128))) {
    return IP_RULE_HINT;
  }

  return undefined;
}

export function AccessSection({
  kind,
  targetId,
  name,
  publicPort,
  access,
  gate,
  unavailable,
  onSaved,
}: {
  kind: "service" | "project";
  targetId: string;
  name: string;
  /** The port clients connect to. Unchanged by the restriction. */
  publicPort: number | null;
  access: AccessValue;
  gate: GateValue;
  /** Why the restriction cannot be applied here, when it cannot. */
  unavailable?: string;
  /** Receives the updated row, so a caller holding one can merge it. */
  onSaved: (updated: Record<string, unknown>) => void;
}) {
  const [mode, setMode] = useState<AccessMode>(access.mode);
  const [allow, setAllow] = useState<string[]>(access.allow);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [networks, setNetworks] = useState<SuggestedNetwork[]>([]);
  const [clientIp, setClientIp] = useState<string | null>(null);

  /*
    Re-sync only when the stored answer actually changes.

    The page polls every few seconds and hands this component the same props
    each time; resetting on every one of them would wipe a half-made choice
    while it was being made. Comparing against a baseline means an unchanged
    poll is a no-op, and a genuine change — our own save landing, or another
    tab's — wins. Adjusted during render rather than in an effect, which is what
    React recommends for state derived from props: an effect here would render
    once with the stale value first.
  */
  const stored = useMemo(() => JSON.stringify([access.mode, access.allow]), [access.mode, access.allow]);
  const [baseline, setBaseline] = useState(stored);
  if (stored !== baseline) {
    setBaseline(stored);
    setMode(access.mode);
    setAllow(access.allow);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/network/suggestions")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setNetworks(data.networks ?? []);
        setClientIp(data.clientIp ?? null);
      })
      .catch(() => {
        /* the free-text field still works without suggestions */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = JSON.stringify([mode, allow]) !== JSON.stringify([access.mode, access.allow]);
  const modeChanged = mode !== access.mode;
  const draftError = ruleError(draft);

  function toggleRule(cidr: string) {
    setAllow((current) =>
      current.includes(cidr) ? current.filter((rule) => rule !== cidr) : [...current, cidr]
    );
  }

  function addDraft() {
    const trimmed = draft.trim();
    if (!trimmed || draftError) return;
    if (!allow.includes(trimmed)) setAllow([...allow, trimmed]);
    setDraft("");
  }

  async function save(nextMode: AccessMode, nextAllow: string[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/${kind === "service" ? "services" : "projects"}/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access: { mode: nextMode, allow: nextAllow } }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data.error ?? MSG.saveFailed);
        return;
      }
      if (data.accessWarning) {
        toast.warning(data.accessWarning);
      } else {
        toast.success(nextMode === "restricted" ? "Accesso limitato" : "Accesso aperto");
      }
      onSaved(data);
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setSaving(false);
    }
  }

  const restricted = mode === "restricted";
  const summary = unavailable
    ? unavailable
    : access.mode === "open"
      ? "Aperto: raggiungibile da tutta la rete"
      : access.allow.length === 0
        ? `Solo questa macchina${gate.running ? "" : " · gate non attivo"}`
        : `${access.allow.length} ${access.allow.length === 1 ? "rete consentita" : "reti consentite"}${gate.running ? "" : " · gate non attivo"}`;

  return (
    <Section
      title="Chi può collegarsi"
      summary={summary}
      actions={
        <SettingToggle
          label="Limita"
          isSelected={restricted}
          isDisabled={Boolean(unavailable) || saving}
          onChange={(next) => {
            setMode(next ? "restricted" : "open");
            // Turning it on with an empty list means "only this machine", which
            // is safe and almost never what was meant. The networks this host
            // is actually on start ticked; everything else stays a decision.
            if (next && allow.length === 0) {
              setAllow(networks.filter((n) => n.kind === "lan").map((n) => n.cidr));
            }
          }}
          className="w-auto"
        />
      }
    >
      {unavailable ? (
        <p className="text-muted text-sm">{unavailable}</p>
      ) : (
        <>
          {restricted ? (
            <>
              {/*
                The one thing that has to be seen without being asked for: the
                port is held open by the panel and by nothing else.
              */}
              <Hint tone="warn" title="La porta dipende dal pannello">
                Mentre l&apos;accesso è limitato è RunPanel a tenere aperta la porta{" "}
                <Code>{String(publicPort ?? "—")}</Code>. Se il pannello è spento la porta è chiusa:
                {kind === "service"
                  ? " il database resta raggiungibile solo da questa macchina."
                  : " l'app resta raggiungibile solo da questa macchina."}
              </Hint>

              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <span className="text-foreground text-sm">Reti consentite</span>
                  <InfoTip title="Cosa passa e cosa no">
                    {kind === "service" ? (
                      <>
                        L&apos;app del progetto continua a raggiungere il database per nome del
                        container sulla rete di progetto: quel traffico non passa da qui e non si
                        rompe mai. Passa da qui invece chi arriva da{" "}
                        <Code>host.docker.internal</Code>, che è il motivo per cui le sottoreti
                        virtuali sono fra i suggerimenti.
                      </>
                    ) : (
                      <>
                        Vale per chi apre l&apos;app dalla rete. Le connessioni che l&apos;app fa
                        verso l&apos;esterno, e quelle verso i suoi database, non passano da qui.
                      </>
                    )}
                  </InfoTip>
                </div>

                {/* Not listable, not removable, and said out loud so its absence
                    from the list below does not read as an omission. */}
                <div className="border-separator text-muted flex items-center gap-2 rounded-[var(--radius)] border border-dashed px-3 py-2 text-xs">
                  <Icon icon="solar:home-2-linear" width={15} aria-hidden />
                  <span className="flex-1">
                    Questa macchina (<Code>127.0.0.1</Code>, <Code>::1</Code>)
                  </span>
                  <span className="text-meta">sempre consentita</span>
                </div>

                {networks.map((network) => (
                  <label
                    key={network.cidr}
                    className={cn(
                      "border-separator hover:bg-surface-hover flex cursor-pointer items-center gap-2.5 rounded-[var(--radius)] border px-3 py-2 transition-colors",
                      // Quiet, because this is the one multi-select here: several
                      // rows are lit at once, and haloing each would turn a
                      // choice into wallpaper.
                      allow.includes(network.cidr) && "selected-quiet border-transparent"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={allow.includes(network.cidr)}
                      onChange={() => toggleRule(network.cidr)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm">
                        {network.label || network.iface}
                        <span className="text-muted font-mono"> — {network.cidr}</span>
                      </span>
                      <span className="text-muted block truncate text-meta">
                        {KIND_LABEL[network.kind]} · questa macchina è {network.address}
                      </span>
                    </span>
                  </label>
                ))}

                {clientIp && (
                  <label className="border-separator hover:bg-surface-hover flex cursor-pointer items-center gap-2.5 rounded-[var(--radius)] border px-3 py-2 transition-colors">
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={allow.includes(clientIp)}
                      onChange={() => toggleRule(clientIp)}
                    />
                    <span className="text-foreground flex-1 text-sm">
                      Il tuo indirizzo ora
                      <span className="text-muted font-mono"> — {clientIp}</span>
                    </span>
                  </label>
                )}

                {/* Rules typed by hand or carried over from another host. */}
                {allow
                  .filter((rule) => !networks.some((n) => n.cidr === rule) && rule !== clientIp)
                  .map((rule) => (
                    <div
                      key={rule}
                      className="border-separator flex items-center gap-2.5 rounded-[var(--radius)] border px-3 py-2"
                    >
                      <Icon icon="solar:check-circle-linear" width={15} className="text-accent" aria-hidden />
                      <span className="text-foreground flex-1 truncate font-mono text-sm">{rule}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Rimuovi ${rule}`}
                        onPress={() => toggleRule(rule)}
                      >
                        <Icon icon="solar:close-circle-linear" width={15} aria-hidden />
                      </Button>
                    </div>
                  ))}
              </div>

              <Field label="Aggiungi un indirizzo o una rete" htmlFor="access-rule" error={draftError}>
                <div className="flex gap-2">
                  <TextField
                    value={draft}
                    onChange={setDraft}
                    className="flex-1"
                    aria-label="Indirizzo o rete da consentire"
                  >
                    <Input
                      id="access-rule"
                      placeholder="10.0.0.0/8"
                      className="font-mono text-sm"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addDraft();
                        }
                      }}
                    />
                  </TextField>
                  <Button variant="secondary" isDisabled={!draft.trim() || Boolean(draftError)} onPress={addDraft}>
                    Aggiungi
                  </Button>
                </div>
              </Field>

              {allow.length === 0 && (
                <FieldHint>
                  Nessuna rete selezionata: solo questa macchina potrà collegarsi.
                </FieldHint>
              )}

              {gate.leakingFrom && (
                <Hint tone="warn" title="L&apos;app non sta rispettando il bind">
                  La porta interna risponde ancora su <Code>{gate.leakingFrom}</Code>: l&apos;app
                  ignora <Code>HOST</Code> e resta in ascolto su tutte le interfacce, quindi si può
                  raggiungere senza passare da qui. Aggiungi al comando di avvio l&apos;opzione che
                  la lega a <Code>127.0.0.1</Code>.
                </Hint>
              )}

              {gate.rejections.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-foreground text-sm">Rifiutati di recente</span>
                  {gate.rejections.slice(0, 5).map((rejection) => (
                    <div
                      key={rejection.address}
                      className="border-separator flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5"
                    >
                      <span className="text-foreground flex-1 truncate font-mono text-xs">
                        {rejection.address}
                      </span>
                      <span className="text-muted text-meta">
                        {rejection.attempts > 1 && `${rejection.attempts} tentativi · `}
                        {formatRelative(rejection.lastAt)}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        isDisabled={saving || allow.includes(rejection.address)}
                        onPress={() => {
                          if (!allow.includes(rejection.address)) setAllow([...allow, rejection.address]);
                        }}
                      >
                        Consenti
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-muted text-sm">
              La porta <Code>{String(publicPort ?? "—")}</Code> è pubblicata su tutte le interfacce:
              chiunque raggiunga questa macchina in rete può collegarsi.
            </p>
          )}

          {dirty && (
            <div className="border-separator flex items-center justify-end gap-2 border-t pt-3">
              <Button
                variant="ghost"
                isDisabled={saving}
                onPress={() => {
                  setMode(access.mode);
                  setAllow(access.allow);
                  setDraft("");
                }}
              >
                Annulla
              </Button>
              <Button
                variant="primary"
                isPending={saving}
                onPress={() => (modeChanged ? setConfirming(true) : save(mode, allow))}
              >
                Salva
              </Button>
            </div>
          )}
        </>
      )}

      {/*
        Only when the mode changes: that is the edit that moves the listener,
        and moving it means recreating the container or restarting the app.
        Editing the list of networks does neither, and asking for confirmation
        there would train the operator to dismiss the dialog without reading it.
      */}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={restricted ? `Limitare l'accesso a "${name}"?` : `Riaprire l'accesso a "${name}"?`}
        confirmLabel={restricted ? "Limita" : "Riapri"}
        description={
          kind === "service"
            ? "Il container viene ricreato per spostare la porta. I dati restano nel volume e il collegamento al progetto non cambia, ma le connessioni aperte cadono."
            : "L'app viene riavviata per spostare la porta su cui ascolta. Torna su con l'ultima build riuscita."
        }
        onConfirm={() => save(mode, allow)}
      />
    </Section>
  );
}
