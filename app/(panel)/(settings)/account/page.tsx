"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { ThemeModePicker } from "@/components/ui/ThemeModePicker";
import { SessionList } from "@/components/ui/SessionList";
import { useMe } from "@/lib/hooks/useMe";

/**
 * Yours: how you sign in, where you are signed in, how the panel looks in this
 * browser. What the panel does for everyone lives in the Pannello tab
 * (`/settings`), which used to be the bottom half of this page.
 */
export default function AccountPage() {
  const me = useMe();
  const [email, setEmail] = useState(me.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function changeEmail() {
    setEmailSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), currentPassword: emailPassword }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(d.error || "Cambio email non riuscito");
        return;
      }
      toast.success("Email aggiornata: usala dal prossimo accesso");
      setEmailPassword("");
    } catch {
      toast.error("Cambio email non riuscito");
    } finally {
      setEmailSaving(false);
    }
  }

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      toast.error("Le due password non coincidono");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("La password deve avere almeno 8 caratteri");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error || "Cambio password non riuscito");
        return;
      }
      toast.success("Password cambiata");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      toast.error("Cambio password non riuscito");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Account"
        description="Accesso, dispositivi e aspetto"
      />

      <div className="max-w-3xl space-y-4">
        <Panel className="space-y-4">
          <PanelHeader
            title="Email di accesso"
            description={me.isOwner ? "Sei il proprietario del pannello" : "Il nome con cui entri nel pannello"}
          />
          <TextField type="email" value={email} onChange={setEmail}>
            <Label>Email</Label>
            <Input autoComplete="username" />
          </TextField>
          <TextField type="password" value={emailPassword} onChange={setEmailPassword}>
            <Label>Password attuale</Label>
            <Input autoComplete="current-password" />
          </TextField>
          <div>
            <Button
              variant="secondary"
              isPending={emailSaving}
              isDisabled={!email.trim() || email.trim() === me.email || !emailPassword}
              onPress={changeEmail}
            >
              Cambia email
            </Button>
          </div>
        </Panel>

        <Panel className="space-y-4">
          <PanelHeader
            title="Cambia password"
            description="Le altre sessioni vengono chiuse, questa resta"
          />
          <TextField type="password" value={currentPassword} onChange={setCurrentPassword}>
            <Label>Password attuale</Label>
            <Input autoComplete="current-password" />
          </TextField>
          <TextField type="password" value={newPassword} onChange={setNewPassword}>
            <Label>Nuova password</Label>
            <Input autoComplete="new-password" />
          </TextField>
          <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
            <Label>Conferma la nuova password</Label>
            <Input autoComplete="new-password" />
          </TextField>
          <div>
            <Button variant="primary" isPending={loading} onPress={changePassword}>
              Cambia password
            </Button>
          </div>
        </Panel>

        <Section title="Dispositivi" summary="Sessioni attive su questo account">
          <SessionList />
        </Section>

        <Section title="Aspetto" summary="Tema chiaro, scuro o quello del sistema" defaultExpanded>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Tema</p>
              <p className="text-muted text-xs">Vale solo per questo browser.</p>
            </div>
            <ThemeModePicker />
          </div>
        </Section>
      </div>
    </>
  );
}
