"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { FormDialog } from "@/components/ui/FormDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DangerZone } from "@/components/ui/DangerAction";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { AccessEditor, type AccessValue } from "@/components/users/AccessEditor";
import { DurationPicker, LinkResultDialog } from "@/components/users/LinkDialogs";
import { STATUS_LABEL } from "@/components/users/labels";
import { useResource } from "@/lib/hooks/useResource";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { useMe } from "@/lib/hooks/useMe";
import { formatRelative, formatWhen } from "@/lib/format";
import type { GlobalPermission } from "@/lib/authz";

interface Detail {
  user: {
    id: string;
    email: string | null;
    isOwner: boolean;
    status: string;
    createdAt: string;
    lastLoginAt: string | null;
    inviteExpiresAt: string | null;
  };
  access: AccessValue | null;
  editable: boolean;
}

/** One account: what it can reach, and the actions on it. */
export default function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const router = useRouter();
  const me = useMe();
  const detail = useResource<Detail>(`/api/users/${userId}`);
  useCrumbLabel(userId, detail.data?.user.email);
  const [linkOpen, setLinkOpen] = useState(false);
  const [hours, setHours] = useState<number | null>(24);
  const [link, setLink] = useState<{ url: string; expiresAt: string; kind: "invite" | "reset" } | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const canGrant = (permission: GlobalPermission) => me.isOwner || me.permissions.includes(permission);

  async function patch(body: unknown, success: string): Promise<boolean> {
    const res = await fetch(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error || "Salvataggio non riuscito");
      return false;
    }
    toast.success(success);
    await detail.refresh();
    return true;
  }

  async function issueLink(): Promise<boolean> {
    if (!hours) {
      toast.error("Scegli una validità tra 1 ora e 30 giorni");
      return false;
    }
    const res = await fetch(`/api/users/${userId}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error || "Non è stato possibile creare il link");
      return false;
    }
    setLinkOpen(false);
    setLink({ url: `${window.location.origin}${data.invitePath}`, expiresAt: data.expiresAt, kind: data.kind });
    await detail.refresh();
    return true;
  }

  if (detail.error && !detail.data) {
    return (
      <>
        <PageHeader title="Utente" back={{ href: "/users", label: "Torna agli utenti" }} />
        <LoadError what="l'utente" error={detail.error} onRetry={detail.refresh} />
      </>
    );
  }
  if (!detail.data) return <PageSkeleton tiles={0} />;

  const { user, editable } = detail.data;
  const status = STATUS_LABEL[user.status] ?? STATUS_LABEL.active;
  const disabled = user.status === "disabled";
  const hasPassword = user.status === "active" || (disabled && user.lastLoginAt !== null);

  return (
    <>
      <PageHeader
        back={{ href: "/users", label: "Torna agli utenti" }}
        title={user.email ?? "Email non ancora impostata"}
        description={
          user.isOwner
            ? "Proprietario del pannello: ha sempre tutti i permessi"
            : `${status.label} · ${user.lastLoginAt ? `ultimo accesso ${formatRelative(user.lastLoginAt)}` : "mai entrato"}`
        }
      />

      <div className="max-w-3xl space-y-4 pb-20">
        {user.isOwner ? (
          <Hint>Il proprietario non si può limitare, disattivare né eliminare.</Hint>
        ) : !editable ? (
          <Hint tone="warn">
            Questo account ha accessi che tu non hai: puoi vederlo, ma non modificarlo né cambiargli la password.
          </Hint>
        ) : null}

        {!user.isOwner && (
          <Panel className="space-y-3">
            <PanelHeader
              title="Accesso"
              description={
                user.status === "invited" && user.inviteExpiresAt
                  ? `Invito in attesa, scade ${formatWhen(user.inviteExpiresAt)}`
                  : user.status === "invite_expired"
                    ? "L'invito è scaduto: generane uno nuovo"
                    : "Un link monouso per scegliere una nuova password"
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" isDisabled={!editable} onPress={() => setLinkOpen(true)}>
                {hasPassword ? "Crea link per nuova password" : "Crea nuovo link di invito"}
              </Button>
              {disabled ? (
                <Button
                  variant="secondary"
                  isDisabled={!editable}
                  onPress={() => patch({ disabled: false }, "Account riattivato")}
                >
                  Riattiva
                </Button>
              ) : (
                <Button variant="secondary" isDisabled={!editable} onPress={() => setConfirmDisable(true)}>
                  Disattiva
                </Button>
              )}
            </div>
          </Panel>
        )}

        {!user.isOwner && detail.data.access && (
          // Remounted when the stored access changes, so the draft restarts from it.
          <AccessForm
            key={JSON.stringify(detail.data.access)}
            stored={detail.data.access}
            canGrant={canGrant}
            editable={editable}
            onSave={(access) => patch({ access }, "Accessi salvati")}
          />
        )}

        {!user.isOwner && editable && (
          <DangerZone
            title="Elimina account"
            description="L'account sparisce con i suoi accessi e le sue sessioni. Il registro attività conserva cosa ha fatto."
            actionLabel="Elimina"
            confirm={{
              title: "Eliminare questo account?",
              description: `${user.email ?? "L'account"} non potrà più entrare. Non si può annullare.`,
              confirmLabel: "Elimina",
            }}
            onConfirm={async () => {
              const res = await fetch(`/api/users/${userId}`, { method: "DELETE" });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                toast.error(data.error || "Eliminazione non riuscita");
                return;
              }
              toast.success("Account eliminato");
              router.push("/users");
            }}
          />
        )}
      </div>

      <FormDialog
        isOpen={linkOpen}
        onOpenChange={setLinkOpen}
        title={hasPassword ? "Link per la nuova password" : "Nuovo link di invito"}
        description={
          hasPassword
            ? "Chi apre il link sceglie una nuova password e chiude le sessioni aperte. I link precedenti smettono di funzionare."
            : "I link precedenti smettono di funzionare."
        }
        submitLabel="Crea link"
        isSubmitDisabled={!hours}
        onSubmit={issueLink}
      >
        <DurationPicker onHours={setHours} />
      </FormDialog>

      <LinkResultDialog link={link} onClose={() => setLink(null)} />

      <ConfirmDialog
        isOpen={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Disattivare questo account?"
        description="Viene disconnesso subito da ogni dispositivo e non può più entrare finché non lo riattivi. Accessi e storico restano."
        confirmLabel="Disattiva"
        destructive
        onConfirm={() => patch({ disabled: true }, "Account disattivato")}
      />
    </>
  );
}

/** The editable copy of an account's access, saved with the sticky bar. */
function AccessForm({
  stored,
  canGrant,
  editable,
  onSave,
}: {
  stored: AccessValue;
  canGrant: (permission: GlobalPermission) => boolean;
  editable: boolean;
  onSave: (access: AccessValue) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<AccessValue>(stored);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  return (
    <>
      <AccessEditor value={draft} onChange={setDraft} canGrant={canGrant} isDisabled={!editable} />
      <StickySaveBar
        isDirty={dirty && editable}
        isPending={saving}
        onSave={async () => {
          setSaving(true);
          try {
            await onSave(draft);
          } finally {
            setSaving(false);
          }
        }}
        onReset={() => setDraft(stored)}
        message="Accessi non salvati"
        saveLabel="Salva accessi"
      />
    </>
  );
}
