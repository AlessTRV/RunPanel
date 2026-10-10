"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TextField, Label, Input, Button, Spinner } from "@heroui/react";
import Image from "next/image";
import logo from "@/components/logo.svg";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [loading, setLoading] = useState(false);
  // Shown under the fields rather than only as a toast: a toast is gone before
  // you have looked back at what you typed.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          router.push(data.emailRequired ? "/setup-email" : "/home");
        }
        setIsFirstRun(data.firstRun);
      })
      .catch(() => setIsFirstRun(false));
  }, [router]);

  async function handleLogin() {
    if (!password) {
      setError("Inserisci la password");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        router.push(data.emailRequired ? "/setup-email" : "/home");
      } else {
        setError(data.error || "Credenziali non valide");
      }
    } catch {
      setError("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetup() {
    if (!setupToken.trim()) {
      setError("Serve il token che il pannello ha stampato nel suo log di avvio");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Serve un'email valida: sarà il tuo nome di accesso");
      return;
    }
    if (password.length < 8) {
      setError("La password deve avere almeno 8 caratteri");
      return;
    }
    if (password !== confirmPassword) {
      setError("Le due password non coincidono");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, setup: true, setupToken: setupToken.trim() }),
      });
      if (res.ok) {
        router.push("/home");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Configurazione non riuscita");
      }
    } catch {
      setError("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  if (isFirstRun === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Panel className="w-full max-w-md p-6 sm:p-8">
        {/* A real form: Enter submits from any field, and password managers
            recognise it as a sign-in. */}
        <form
          className="space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void (isFirstRun ? handleSetup() : handleLogin());
          }}
        >
        <div className="flex flex-col items-center gap-2 text-center">
          <Image src={logo} alt="" aria-hidden width={44} height={44} className="size-11" priority />
          <h1 className="text-foreground text-xl font-semibold tracking-tight">RunPanel</h1>
          <p className="text-muted text-sm">
            {isFirstRun ? "Crea l'account proprietario del pannello" : "Accedi per continuare"}
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

          <TextField type="email" value={email} onChange={setEmail} autoFocus={!isFirstRun}>
            <Label>Email</Label>
            <Input placeholder="nome@esempio.it" autoComplete="username" />
          </TextField>
          {!isFirstRun && (
            // One line rather than a paragraph: it concerns an upgrade that
            // happens once, and was the longest text on the screen every day.
            <FieldHint>Account senza email, da una versione vecchia? Lascia vuoto.</FieldHint>
          )}

          <TextField type="password" value={password} onChange={setPassword}>
            <Label>Password</Label>
            <Input autoComplete={isFirstRun ? "new-password" : "current-password"} />
          </TextField>

          {isFirstRun && (
            <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
              <Label>Conferma password</Label>
              <Input autoComplete="new-password" />
            </TextField>
          )}
        </div>

        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" className="w-full" isPending={loading}>
          {isFirstRun ? "Configura il pannello" : "Accedi"}
        </Button>
        </form>
      </Panel>
    </div>
  );
}
