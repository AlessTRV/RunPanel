"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TextField, Label, Input, Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel } from "@/components/ui/Panel";
import { FieldHint } from "@/components/ui/Hint";

/**
 * One step for the owner of a panel set up before accounts existed: it had a
 * password and nothing else, and from now on the email is the login name.
 * The panel layout sends them here until it is set.
 */
export default function SetupEmailPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error("Serve un'email valida");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), currentPassword: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Salvataggio non riuscito");
        return;
      }
      toast.success("Email salvata: d'ora in poi accedi con email e password");
      router.push("/home");
      router.refresh();
    } catch {
      toast.error("Impossibile raggiungere il pannello");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Panel className="w-full max-w-md space-y-5 p-6 sm:p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Icon icon="solar:shield-user-linear" className="text-accent" width={44} aria-hidden />
          <h1 className="text-foreground text-xl font-semibold tracking-tight">Imposta la tua email</h1>
          <p className="text-muted text-sm">
            Il pannello ora ha più account. La tua email diventa il nome con cui accedi, insieme alla
            password che usi già.
          </p>
        </div>

        <div className="space-y-4">
          <TextField type="email" value={email} onChange={setEmail} autoFocus>
            <Label>Email</Label>
            <Input placeholder="nome@esempio.it" autoComplete="username" />
          </TextField>
          <div>
            <TextField type="password" value={password} onChange={setPassword}>
              <Label>Password attuale</Label>
              <Input
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
            </TextField>
            <FieldHint>La stessa con cui sei appena entrato: conferma che sei tu.</FieldHint>
          </div>
        </div>

        <Button variant="primary" className="w-full" isPending={saving} onPress={save}>
          Salva e continua
        </Button>
      </Panel>
    </div>
  );
}
