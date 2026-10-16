"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { toast } from "sonner";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { LoadError } from "@/components/ui/LoadError";
import { FieldHint } from "@/components/ui/Hint";
import { SelectField } from "@/components/ui/SelectField";
import { useResource } from "@/lib/hooks/useResource";
import { useCan } from "@/lib/hooks/useMe";
import type { Grant, Level } from "@/lib/authz";
import { LEVEL_LABEL, LEVEL_OPTIONS } from "./labels";
import { useNodeApi } from "@/lib/hooks/useNode";

interface Row {
  id: string;
  email: string | null;
  isOwner: boolean;
  disabled: boolean;
  level: Level;
  terminal: boolean;
  direct: Grant | null;
  editable: boolean;
}

/**
 * Who reaches this project or service, on its own settings tab — for whoever
 * manages users. A direct grant can be changed or added here; access that
 * comes through "all" or a folder is shown with a link to the person's page,
 * where it lives.
 */
export function AccessPanel({ kind, id }: { kind: "project" | "service"; id: string }) {
  const api = useNodeApi();
  const canManage = useCan("users.manage");
  const access = useResource<{ users: Row[] }>(canManage ? api(`/api/users/access?kind=${kind}&id=${id}`) : null);
  const everyone = useResource<{ users: Array<{ id: string; email: string | null; isOwner: boolean }> }>(
    canManage ? api("/api/users") : null
  );
  const [pick, setPick] = useState("");
  const [level, setLevel] = useState<Level>("read");
  const [busy, setBusy] = useState(false);

  if (!canManage) return null;

  /** Rewrites one person's grant on this target, keeping the rest of their access. */
  async function setDirect(userId: string, next: Grant | null) {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/users/${userId}`));
      const data = await res.json();
      if (!res.ok || !data.access) throw new Error(data.error || "Utente non modificabile");
      const others = (data.access.grants as Grant[]).filter((g) => !(g.scope === kind && g.scopeId === id));
      const patch = await fetch(api(`/api/users/${userId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access: { permissions: data.access.permissions, grants: next ? [...others, next] : others } }),
      });
      const result = await patch.json().catch(() => ({}));
      if (!patch.ok) throw new Error(result.error || "Salvataggio non riuscito");
      toast.success("Accesso aggiornato");
      await access.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Salvataggio non riuscito");
    } finally {
      setBusy(false);
    }
  }

  const listed = new Set((access.data?.users ?? []).map((u) => u.id));
  const candidates = (everyone.data?.users ?? []).filter((u) => !u.isOwner && !listed.has(u.id));

  return (
    <Section title="Chi ha accesso" summary="Gli account che raggiungono questo elemento, e con quale livello">
      {access.error && !access.data ? (
        <LoadError what="gli accessi" error={access.error} onRetry={access.refresh} />
      ) : !access.data ? (
        <SkeletonBlock className="h-24" />
      ) : (
        <div className="space-y-4">
          <ul className="divide-border divide-y">
            {access.data.users.map((user) => (
              <li key={user.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Link href={`/users/${user.id}`} className="text-foreground truncate text-sm font-medium hover:underline">
                    {user.email ?? "Proprietario"}
                  </Link>
                  <p className="text-muted text-xs">
                    {user.isOwner
                      ? "Proprietario"
                      : `${LEVEL_LABEL[user.level]}${user.terminal ? " · terminale" : ""}${user.direct ? "" : " · tramite un accesso più ampio"}${user.disabled ? " · disattivato" : ""}`}
                  </p>
                </div>
                {user.direct && user.editable && (
                  <div className="flex items-center gap-2">
                    <Segmented
                      label={`Livello di ${user.email}`}
                      value={user.direct.level}
                      onChange={(next: Level) => setDirect(user.id, { ...user.direct!, level: next, terminal: next === "read" ? false : user.direct!.terminal })}
                      options={LEVEL_OPTIONS.map((o) => ({ value: o.value, label: o.label, isDisabled: busy }))}
                    />
                    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setDirect(user.id, null)}>
                      Togli
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {candidates.length > 0 && (
            <div className="border-border space-y-2 border-t pt-3">
              <span className="text-foreground block text-sm font-medium">Dai accesso</span>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <SelectField
                  ariaLabel="Account"
                  className="min-w-0 sm:w-64"
                  placeholder="Scegli un account…"
                  value={pick || null}
                  onChange={setPick}
                  options={candidates.map((u) => ({ value: u.id, label: u.email ?? "—" }))}
                />
                <Segmented label="Livello" value={level} onChange={setLevel} options={LEVEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
                <Button
                  variant="secondary"
                  isDisabled={!pick || busy}
                  onPress={() => {
                    void setDirect(pick, { scope: kind, scopeId: id, level, terminal: false });
                    setPick("");
                  }}
                >
                  Aggiungi
                </Button>
              </div>
              <FieldHint>Terminale e permessi più ampi si danno dalla pagina dell&apos;utente.</FieldHint>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
