"use client";

import { useMemo, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Segmented } from "@/components/ui/Segmented";
import { FieldHint } from "@/components/ui/Hint";
import { SelectField } from "@/components/ui/SelectField";
import { EmptyState } from "@/components/ui/EmptyState";
import { useResource } from "@/lib/hooks/useResource";
import { PRESETS, levelRank, type GlobalPermission, type Grant, type Level } from "@/lib/authz";
import { LEVEL_OPTIONS, PERMISSION_GROUPS } from "./labels";

export interface AccessValue {
  permissions: GlobalPermission[];
  grants: Grant[];
}

interface Named {
  id: string;
  name: string;
}

/**
 * What a grant can point at, by kind, with the names the panel shows — from
 * every server of the cluster, each name suffixed with the server's.
 */
function useTargets() {
  const targets = useResource<{ folder: Named[]; project: Named[]; service: Named[]; linkedService: Named[] }>("/api/cluster/targets");
  return useMemo(
    () => ({
      folder: targets.data?.folder ?? [],
      project: targets.data?.project ?? [],
      service: targets.data?.service ?? [],
      linkedService: targets.data?.linkedService ?? [],
    }),
    [targets.data]
  );
}

const SCOPE_LABEL: Record<Grant["scope"], string> = {
  all: "Tutti i progetti e servizi",
  folder: "Cartella",
  project: "Progetto",
  service: "Servizio",
};

/**
 * Who may do what, edited as a whole and saved by the page.
 *
 * `canGrant` is what the editing account itself holds: the server refuses
 * anything beyond it, so the controls for it are shown disabled rather than
 * left to fail on save.
 */
export function AccessEditor({
  value,
  onChange,
  canGrant,
  isDisabled,
}: {
  value: AccessValue;
  onChange: (next: AccessValue) => void;
  canGrant: (permission: GlobalPermission) => boolean;
  isDisabled?: boolean;
}) {
  const targets = useTargets();
  const [filter, setFilter] = useState("");
  const [pick, setPick] = useState("");

  const nameOf = (grant: Grant) => {
    if (grant.scope === "all") return SCOPE_LABEL.all;
    const list =
      grant.scope === "service" ? [...targets.service, ...targets.linkedService] : targets[grant.scope];
    return list.find((t) => t.id === grant.scopeId)?.name ?? "Elemento non visibile";
  };

  const setGrant = (index: number, patch: Partial<Grant>) => {
    const grants = value.grants.map((g, i) => {
      if (i !== index) return g;
      const next = { ...g, ...patch };
      // The terminal means nothing below operate; the server drops it too.
      if (levelRank(next.level) < levelRank("operate")) next.terminal = false;
      return next;
    });
    onChange({ ...value, grants });
  };

  const taken = new Set(value.grants.map((g) => `${g.scope}:${g.scopeId ?? ""}`));
  const q = filter.trim().toLowerCase();
  const options = (["folder", "project", "service"] as const).map((scope) => ({
    scope,
    items: (scope === "service" ? [...targets.service, ...targets.linkedService] : targets[scope]).filter(
      (t) => !taken.has(`${scope}:${t.id}`) && (!q || t.name.toLowerCase().includes(q))
    ),
  }));

  const addGrant = () => {
    if (!pick) return;
    const [scope, id] = pick.split(":") as [Grant["scope"], string];
    onChange({
      ...value,
      grants: [...value.grants, { scope, scopeId: scope === "all" ? null : id, level: "read", terminal: false }],
    });
    setPick("");
  };

  const applyPreset = (key: keyof typeof PRESETS | "none") => {
    if (key === "none") return onChange({ permissions: [], grants: [] });
    const preset = PRESETS[key];
    onChange({ permissions: preset.permissions.filter(canGrant), grants: preset.grants.map((g) => ({ ...g })) });
  };

  return (
    <div className="space-y-4">
      <Panel className="space-y-3">
        <PanelHeader title="Modelli rapidi" description="Riempiono i campi qui sotto: poi puoi ritoccare tutto" />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" isDisabled={isDisabled} onPress={() => applyPreset("viewer")}>
            Visualizzatore
          </Button>
          <Button size="sm" variant="secondary" isDisabled={isDisabled} onPress={() => applyPreset("developer")}>
            Sviluppatore
          </Button>
          <Button size="sm" variant="secondary" isDisabled={isDisabled} onPress={() => applyPreset("sysop")}>
            Operatore sistema
          </Button>
          <Button size="sm" variant="ghost" isDisabled={isDisabled} onPress={() => applyPreset("none")}>
            Nessun accesso
          </Button>
        </div>
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader
          title="Progetti e servizi"
          description="Il livello più alto tra quelli che valgono per un elemento è quello che conta"
        />

        {value.grants.length === 0 ? (
          <EmptyState
            icon="solar:lock-keyhole-linear"
            title="Nessun accesso"
            description="Questo account non vede nessun progetto né servizio."
          />
        ) : (
          <ul className="divide-border divide-y">
            {value.grants.map((grant, index) => (
              <li key={`${grant.scope}:${grant.scopeId ?? ""}`} className="space-y-2 py-3 first:pt-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-medium">{nameOf(grant)}</p>
                    <p className="text-muted text-xs">
                      {grant.scope === "all"
                        ? "Anche quelli creati in futuro"
                        : grant.scope === "folder"
                          ? "Cartella: vale per tutto ciò che contiene, anche in futuro"
                          : SCOPE_LABEL[grant.scope]}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label="Togli questo accesso"
                    isDisabled={isDisabled}
                    onPress={() => onChange({ ...value, grants: value.grants.filter((_, i) => i !== index) })}
                  >
                    <Icon icon="solar:trash-bin-minimalistic-linear" width={16} aria-hidden />
                  </Button>
                </div>
                <Segmented
                  label="Livello"
                  value={grant.level}
                  onChange={(level: Level) => setGrant(index, { level })}
                  options={LEVEL_OPTIONS.map((o) => ({ value: o.value, label: o.label, isDisabled }))}
                />
                <SettingToggle
                  label="Terminale e console"
                  description={
                    levelRank(grant.level) < levelRank("operate")
                      ? "Serve almeno il livello Operatore."
                      : grant.terminal
                        ? "Acceso: apre una shell nei container. Ogni persona ha la sua sessione."
                        : "Spento: nessuna shell nei container."
                  }
                  isSelected={grant.terminal}
                  isDisabled={isDisabled || levelRank(grant.level) < levelRank("operate")}
                  onChange={(terminal) => setGrant(index, { terminal })}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="border-border space-y-2 border-t pt-4">
          <span className="text-foreground block text-sm font-medium">Aggiungi un accesso</span>
          <TextField value={filter} onChange={setFilter} isDisabled={isDisabled}>
            <Label className="sr-only">Cerca</Label>
            <Input placeholder="Cerca per nome…" />
          </TextField>
          <div className="flex flex-col gap-2 sm:flex-row">
            <SelectField
              ariaLabel="Elemento a cui dare accesso"
              className="min-w-0"
              value={pick || null}
              isDisabled={isDisabled}
              onChange={setPick}
              options={[
                ...(taken.has("all:") ? [] : [{ value: "all:", label: SCOPE_LABEL.all }]),
                // The scope that used to be an <optgroup> header rides along as
                // each option's second line.
                ...options.flatMap((group) =>
                  group.items.map((item) => ({
                    value: `${group.scope}:${item.id}`,
                    label: item.name,
                    description: SCOPE_LABEL[group.scope],
                  }))
                ),
              ]}
            />
            <Button variant="secondary" isDisabled={isDisabled || !pick} onPress={addGrant}>
              Aggiungi
            </Button>
          </div>
          <FieldHint>Un servizio collegato a un progetto segue anche l&apos;accesso al progetto.</FieldHint>
        </div>
      </Panel>

      {PERMISSION_GROUPS.map((group) => (
        <Panel key={group.title} className="space-y-3">
          <PanelHeader title={group.title} />
          {group.items.map((item) => {
            const held = value.permissions.includes(item.key);
            const grantable = canGrant(item.key);
            return (
              <SettingToggle
                key={item.key}
                label={item.label}
                description={grantable ? item.description : `${item.description} Non puoi concederlo: non lo hai.`}
                isSelected={held}
                isDisabled={isDisabled || !grantable}
                onChange={(on) =>
                  onChange({
                    ...value,
                    permissions: on ? [...value.permissions, item.key] : value.permissions.filter((p) => p !== item.key),
                  })
                }
              />
            );
          })}
        </Panel>
      ))}
    </div>
  );
}
