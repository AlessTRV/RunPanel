"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { FormDialog } from "@/components/ui/FormDialog";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { DurationPicker, LinkResultDialog } from "@/components/users/LinkDialogs";
import { STATUS_LABEL } from "@/components/users/labels";
import { useResource } from "@/lib/hooks/useResource";
import { formatRelative } from "@/lib/format";

interface UserRow {
  id: string;
  email: string | null;
  isOwner: boolean;
  status: string;
  lastLoginAt: string | null;
  inviteExpiresAt: string | null;
}

/** Every account, and the way in for a new one. */
export default function UsersPage() {
  const users = useResource<{ users: UserRow[] }>("/api/users");
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [hours, setHours] = useState<number | null>(24);
  const [link, setLink] = useState<{ url: string; expiresAt: string; kind: "invite" | "reset" } | null>(null);

  async function invite(): Promise<boolean> {
    if (!hours) {
      toast.error("Scegli una validità tra 1 ora e 30 giorni");
      return false;
    }
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), hours }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error || "Invito non riuscito");
      return false;
    }
    setInviting(false);
    setEmail("");
    setLink({ url: `${window.location.origin}${data.invitePath}`, expiresAt: data.expiresAt, kind: "invite" });
    await users.refresh();
    return true;
  }

  return (
    <>
      <PageHeader
        title="Utenti"
        description="Chi entra nel pannello e cosa può fare"
        actions={
          <Button variant="primary" onPress={() => setInviting(true)}>
            <Icon icon="solar:user-plus-linear" width={16} aria-hidden />
            Invita utente
          </Button>
        }
      />

      {users.error && !users.data ? (
        <LoadError what="gli utenti" error={users.error} onRetry={users.refresh} />
      ) : !users.data ? (
        <SkeletonBlock className="h-40" />
      ) : (
        <Panel padding="flush" className="overflow-hidden">
          <ul className="divide-border divide-y">
            {users.data.users.map((user) => {
              const status = STATUS_LABEL[user.status] ?? STATUS_LABEL.active;
              return (
                <li key={user.id}>
                  <Link
                    href={`/users/${user.id}`}
                    className="hover:bg-surface-hover flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-foreground truncate text-sm font-medium">
                        {user.email ?? "Email non ancora impostata"}
                      </p>
                      <p className="text-muted text-xs">
                        {user.isOwner ? "Proprietario" : <span className={status.tone}>{status.label}</span>}
                        {" · "}
                        {user.lastLoginAt ? `ultimo accesso ${formatRelative(user.lastLoginAt)}` : "mai entrato"}
                      </p>
                    </div>
                    <Icon icon="solar:alt-arrow-right-linear" className="text-muted shrink-0" width={16} aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <FormDialog
        isOpen={inviting}
        onOpenChange={setInviting}
        title="Invita utente"
        description="L'account nasce senza accessi: li scegli subito dopo, nella sua pagina."
        submitLabel="Crea link di invito"
        isSubmitDisabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !hours}
        onSubmit={invite}
      >
        <div className="space-y-4">
          <TextField type="email" value={email} onChange={setEmail} autoFocus>
            <Label>Email</Label>
            <Input placeholder="nome@esempio.it" />
          </TextField>
          <DurationPicker onHours={setHours} />
        </div>
      </FormDialog>

      <LinkResultDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}
