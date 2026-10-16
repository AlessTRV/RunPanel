"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TextField, Label, Input, Button, Spinner } from "@heroui/react";
import Image from "next/image";
import logo from "@/components/logo.svg";
import { Panel } from "@/components/ui/Panel";
import { Code, FieldHint } from "@/components/ui/Hint";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";

/**
 * The first screen the operator ever sees, and the one that was entirely in
 * English in an otherwise Italian panel.
 *
 * It also carried the only `shadow-2xl` in the app, against a token layer whose
 * own comment says depth comes from the surface steps and the border — "flat by
 * default" being most of the difference between minimal and dated. A login card
 * is exactly where that temptation shows up, and exactly where it looks least
 * like the rest of the product.
 *
 * On a first run there are two ways to set the panel up: create the owner, or
 * link this install to a RunPanel that already exists and inherit its
 * accounts. A managed node of a cluster shows neither: it has no sign-in of
 * its own and points at the panels that have.
 */

type SetupMode = "owner" | "link";
type LinkRole = "panel" | "node";

interface Check {
  authenticated: boolean;
  firstRun: boolean;
  emailRequired: boolean;
  role: "panel" | "node" | null;
  managedBy?: { name: string; url: string }[];
}

const ROLE_OPTIONS = [
  { value: "panel" as const, label: "Pannello", description: "Anche questo server mostra l'interfaccia e gestisce gli altri" },
  { value: "node" as const, label: "Solo nodo", description: "Nessun accesso qui: si gestisce dai pannelli del cluster" },
];

export default function LoginPage() {
  const router = useRouter();
  const [check, setCheck] = useState<Check | null>(null);
  const [mode, setMode] = useState<SetupMode>("owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [panelUrl, setPanelUrl] = useState("");
  const [linkToken, setLinkToken] = useState("");
  const [serverName, setServerName] = useState("");
  // Prefilled with the address this page was opened at: the form is only
  // rendered after the first-run check, so there is nothing to hydrate against.
  const [serverUrl, setServerUrl] = useState(() => (typeof window !== "undefined" ? window.location.origin : ""));
  const [role, setRole] = useState<LinkRole>("panel");
  const [loading, setLoading] = useState(false);
  // Shown under the fields rather than only as a toast: a toast is gone before
  // you have looked back at what you typed.
  const [error, setError] = useState<string | null>(null);
  const [linkedAs, setLinkedAs] = useState<LinkRole | null>(null);

  const isFirstRun = check?.firstRun ?? null;

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data: Check) => {
        if (data.authenticated) {
          router.push(data.emailRequired ? "/setup-email" : "/home");
        }
        setCheck(data);
      })
      .catch(() => setCheck({ authenticated: false, firstRun: false, emailRequired: false, role: null }));
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

  async function handleLink() {
    if (!setupToken.trim()) {
      setError("Serve il token che il pannello ha stampato nel suo log di avvio");
      return;
    }
    if (!panelUrl.trim() || !linkToken.trim()) {
      setError("Servono l'indirizzo del pannello e il token di collegamento che ha generato");
      return;
    }
    if (!serverName.trim()) {
      setError("Dai un nome a questo server: è come comparirà nel pannello");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setup: true,
          setupToken: setupToken.trim(),
          link: { panelUrl: panelUrl.trim(), token: linkToken.trim(), name: serverName.trim(), url: serverUrl.trim(), role },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setLinkedAs(role);
        if (role === "node") {
          const next = await fetch("/api/auth/check").then((r) => r.json() as Promise<Check>).catch(() => null);
          if (next) setCheck(next);
        } else {
          setCheck((prev) => (prev ? { ...prev, firstRun: false, role: "panel" } : prev));
        }
      } else {
        setError(data.details?.[0]?.message || data.error || "Collegamento non riuscito");
      }
    } catch {
      setError("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  if (check === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // A managed node: nothing to sign into here.
  if (check.role === "node") {
    const panels = check.managedBy ?? [];
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Panel className="w-full max-w-md space-y-5 p-6 sm:p-8">
          <div className="flex flex-col items-center gap-2 text-center">
            <Image src={logo} alt="" aria-hidden width={44} height={44} className="size-11" priority />
            <h1 className="text-foreground text-xl font-semibold tracking-tight">RunPanel</h1>
            <p className="text-muted text-sm">Questo server è gestito da un altro RunPanel.</p>
          </div>
          {panels.length > 0 ? (
            <ul className="space-y-2">
              {panels.map((p) => (
                <li key={p.url}>
                  <a
                    href={`${p.url}/login`}
                    className="border-border bg-surface-2 hover:bg-surface-3 flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="text-foreground font-medium">{p.name}</span>
                    <span className="text-muted font-mono text-xs">{p.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-center text-sm">Accedi da uno dei pannelli del cluster.</p>
          )}
        </Panel>
      </div>
    );
  }

  const title = !isFirstRun
    ? "Accedi per continuare"
    : mode === "owner"
      ? "Crea l'account proprietario del pannello"
      : "Collega questo server a un RunPanel esistente";

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
            void (isFirstRun ? (mode === "owner" ? handleSetup() : handleLink()) : handleLogin());
          }}
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <Image src={logo} alt="" aria-hidden width={44} height={44} className="size-11" priority />
            <h1 className="text-foreground text-xl font-semibold tracking-tight">RunPanel</h1>
            <p className="text-muted text-sm">{title}</p>
          </div>

          {linkedAs === "panel" && (
            <p role="status" className="text-success text-center text-sm">
              Collegato. Accedi con un account del cluster.
            </p>
          )}

          {isFirstRun && (
            <Segmented
              label="Come configurare questo server"
              value={mode}
              onChange={setMode}
              className="justify-center"
              options={[
                { value: "owner", label: "Crea il proprietario" },
                { value: "link", label: "Collega a un RunPanel" },
              ]}
            />
          )}

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

            {isFirstRun && mode === "link" ? (
              <>
                <TextField value={panelUrl} onChange={setPanelUrl}>
                  <Label>Indirizzo del pannello</Label>
                  <Input placeholder="http://100.64.0.5:3000" className="font-mono text-sm" autoComplete="off" />
                </TextField>
                <div>
                  <TextField value={linkToken} onChange={setLinkToken}>
                    <Label>Token di collegamento</Label>
                    <Input className="font-mono text-sm" autoComplete="off" />
                  </TextField>
                  <FieldHint>Lo genera il pannello in Sistema › Server › Collega un server. Vale un&apos;ora.</FieldHint>
                </div>
                <TextField value={serverName} onChange={setServerName}>
                  <Label>Nome di questo server</Label>
                  <Input placeholder="hetzner-2" autoComplete="off" />
                </TextField>
                <div>
                  <TextField value={serverUrl} onChange={setServerUrl}>
                    <Label>Indirizzo di questo server</Label>
                    <Input className="font-mono text-sm" autoComplete="off" />
                  </TextField>
                  <FieldHint>
                    Quello con cui il pannello lo raggiunge: l&apos;IP Tailscale e la porta.
                    {/^https?:\/\/(localhost|127\.|\[::1\])/i.test(serverUrl) && (
                      <>
                        {" "}
                        <span className="text-warning">Un indirizzo locale vale solo da questa macchina: il pannello non lo raggiungerebbe.</span>
                      </>
                    )}
                  </FieldHint>
                </div>
                <SelectField label="Ruolo" value={role} onChange={setRole} options={ROLE_OPTIONS} />
              </>
            ) : (
              <>
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
              </>
            )}
          </div>

          {error && (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" className="w-full" isPending={loading}>
            {!isFirstRun ? "Accedi" : mode === "owner" ? "Configura il pannello" : "Collega il server"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
