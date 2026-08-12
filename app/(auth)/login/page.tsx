"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TextField, Label, Input, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel } from "@/components/ui/Panel";
import { Code, FieldHint } from "@/components/ui/Hint";

/**
 * The first screen the operator ever sees, and the one that was entirely in
 * English in an otherwise Italian panel.
 *
 * It also carried the only `shadow-2xl` in the app, against a token layer whose
 * own comment says depth comes from the surface steps and the border — "flat by
 * default" being most of the difference between minimal and dated. A login card
 * is exactly where that temptation shows up, and exactly where it looks least
 * like the rest of the product.
 */
export default function LoginPage() {
  const router = useRouter();
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          router.push("/home");
        }
        setIsFirstRun(data.firstRun);
      })
      .catch(() => setIsFirstRun(false));
  }, [router]);

  async function handleLogin() {
    if (!password) return;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push("/home");
      } else {
        const data = await res.json();
        toast.error(data.error || "Password errata");
      }
    } catch {
      toast.error("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetup() {
    if (!setupToken.trim()) {
      toast.error("Serve il token che il pannello ha stampato nel suo log di avvio");
      return;
    }
    if (password.length < 8) {
      toast.error("La password deve avere almeno 8 caratteri");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Le due password non coincidono");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, setup: true, setupToken: setupToken.trim() }),
      });
      if (res.ok) {
        router.push("/home");
      } else {
        const data = await res.json();
        toast.error(data.error || "Configurazione non riuscita");
      }
    } catch {
      toast.error("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  if (isFirstRun === null) {
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
          <Icon icon="solar:server-bold-duotone" className="text-accent" width={44} aria-hidden />
          <h1 className="text-foreground text-xl font-semibold tracking-tight">RunPanel</h1>
          <p className="text-muted text-sm">
            {isFirstRun ? "Scegli la password di amministratore" : "Accedi per continuare"}
          </p>
        </div>

        <div className="space-y-4">
          {/*
            Proves the person claiming this panel is the one who can read its
            log, rather than whoever reached the port first.
          */}
          {isFirstRun && (
            <div>
              <TextField value={setupToken} onChange={setSetupToken} autoFocus>
                <Label>Token di setup</Label>
                <Input placeholder="3f9c1a…" className="font-mono text-sm" />
              </TextField>
              <FieldHint>
                Il pannello lo stampa nel proprio log all&apos;avvio, dopo{" "}
                <Code>Not set up yet</Code>. Ne genera uno nuovo a ogni riavvio.
              </FieldHint>
            </div>
          )}

          <TextField type="password" value={password} onChange={setPassword} autoFocus={!isFirstRun}>
            <Label>Password</Label>
            <Input
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isFirstRun) handleLogin();
              }}
            />
          </TextField>

          {isFirstRun && (
            <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
              <Label>Conferma password</Label>
              <Input
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSetup();
                }}
              />
            </TextField>
          )}
        </div>

        <Button
          variant="primary"
          className="w-full"
          isPending={loading}
          onPress={isFirstRun ? handleSetup : handleLogin}
        >
          {isFirstRun ? "Configura il pannello" : "Accedi"}
        </Button>
      </Panel>
    </div>
  );
}
