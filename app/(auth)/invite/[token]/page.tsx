"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TextField, Label, Input, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel } from "@/components/ui/Panel";
import { FieldHint } from "@/components/ui/Hint";

type State =
  | { phase: "loading" }
  | { phase: "invalid"; message: string }
  | { phase: "ready"; email: string; kind: "invite" | "reset" };

/**
 * Where an invitation or reset link lands: choose a password, then straight
 * into the panel. The link works once and expires; past that, it says so and
 * points back at whoever sent it.
 */
export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/auth/invite?token=${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setState({ phase: "invalid", message: data.error || "Link non valido o scaduto." });
        else setState({ phase: "ready", email: data.email, kind: data.kind === "reset" ? "reset" : "invite" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ phase: "invalid", message: "Impossibile raggiungere il pannello." });
      });
    return () => controller.abort();
  }, [token]);

  async function save() {
    if (password.length < 8) {
      toast.error("La password deve avere almeno 8 caratteri");
      return;
    }
    if (password !== confirm) {
      toast.error("Le due password non coincidono");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Non è stato possibile impostare la password");
        return;
      }
      router.push("/home");
    } catch {
      toast.error("Impossibile raggiungere il pannello");
    } finally {
      setSaving(false);
    }
  }

  if (state.phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Panel className="w-full max-w-md space-y-5 p-6 sm:p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Icon
            icon={state.phase === "invalid" ? "solar:danger-triangle-linear" : "solar:key-linear"}
            className={state.phase === "invalid" ? "text-warning" : "text-accent"}
            width={44}
            aria-hidden
          />
          <h1 className="text-foreground text-xl font-semibold tracking-tight">
            {state.phase === "invalid"
              ? "Link non più valido"
              : state.kind === "reset"
                ? "Scegli una nuova password"
                : "Benvenuto su RunPanel"}
          </h1>
          <p className="text-muted text-sm">
            {state.phase === "invalid" ? (
              <>{state.message} Chiedi a chi ti ha invitato di generarne uno nuovo.</>
            ) : (
              <>
                Account <strong className="text-foreground">{state.email}</strong>
              </>
            )}
          </p>
        </div>

        {state.phase === "ready" && (
          <>
            <div className="space-y-4">
              <div>
                <TextField type="password" value={password} onChange={setPassword} autoFocus>
                  <Label>Password</Label>
                  <Input autoComplete="new-password" />
                </TextField>
                <FieldHint>Almeno 8 caratteri. Il link funziona una volta sola.</FieldHint>
              </div>
              <TextField type="password" value={confirm} onChange={setConfirm}>
                <Label>Conferma password</Label>
                <Input
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                  }}
                />
              </TextField>
            </div>
            <Button variant="primary" className="w-full" isPending={saving} onPress={save}>
              {state.kind === "reset" ? "Salva la password" : "Crea l'account"}
            </Button>
          </>
        )}
      </Panel>
    </div>
  );
}
