/**
 * The two judgements that decide whether the panel may replace itself.
 *
 * In their own file, with no imports at all, for the reason
 * `services/autostart/render.ts` gives about the unit it writes: these decide
 * whether a running server kills itself and whether a build lands on top of the
 * one serving the page, and both should be checkable on a laptop rather than
 * only on the machine where getting them wrong costs a night. `run.ts`, which
 * acts on them, reaches the database and the git layer and can be loaded by
 * nothing but the app.
 *
 * The probe is described structurally rather than imported for the same reason:
 * `AutostartProbe` lives behind the `@/` alias.
 */

export type RestartMethod = "systemd" | "cron" | "container" | "manual";

export interface CanUpdate {
  ok: boolean;
  reason: string | null;
  restart: RestartMethod;
}

/** The parts of `AutostartProbe` this needs, and only those. */
export interface RestartProbe {
  environment: { containerised: boolean };
  systemd: { active: boolean };
  cron: { installed: boolean };
}

/**
 * Whether this host can be updated from the panel, and what will bring it back.
 *
 * "Bring it back" is the whole question. The update ends by exiting the
 * process, which is only a restart if something is watching — systemd with
 * `Restart=always`, the cron script's supervision loop. Where nothing is, the
 * answer is still `ok: true`, because the fetching and building are worth doing
 * and are perfectly safe; what changes is that the run stops before the swap
 * and hands the last two steps to a person.
 */
export function canSelfUpdate(
  probe: RestartProbe,
  platform: NodeJS.Platform,
  nodeEnv: string | undefined
): CanUpdate {
  if (nodeEnv !== "production") {
    return {
      ok: false,
      restart: "manual",
      reason:
        "Il pannello è avviato in sviluppo. In quella modalità Next costruisce dentro .next/dev, " +
        "e sostituire la cartella porterebbe via la cache di sviluppo: aggiorna con git a mano.",
    };
  }

  if (platform === "win32") {
    return {
      ok: false,
      restart: "manual",
      reason:
        "Su Windows la cartella di build non si può scambiare mentre il pannello gira: ha handle " +
        "aperti e la rinomina fallisce. Qui l'aggiornamento va fatto a mano, a pannello fermo.",
    };
  }

  if (probe.environment.containerised) {
    return {
      ok: false,
      restart: "container",
      reason:
        "Il pannello gira dentro un container. Un aggiornamento fatto qui vivrebbe nel layer " +
        "scrivibile e sparirebbe alla prima ricreazione del container: ricostruisci l'immagine.",
    };
  }

  if (probe.systemd.active) return { ok: true, reason: null, restart: "systemd" };
  if (probe.cron.installed) return { ok: true, reason: null, restart: "cron" };

  return {
    ok: true,
    restart: "manual",
    reason:
      "Nessun supervisore rilevato: dopo l'uscita niente rimetterebbe su il pannello. " +
      "L'aggiornamento verrà scaricato e costruito, ma non attivato: gli ultimi due comandi li darai tu.",
  };
}

/**
 * Whether the config on disk still routes the build somewhere safe.
 *
 * The trap this closes: `next.config.ts` is a tracked file, so an update
 * *installs its own build configuration* on the way past. A future commit that
 * tidied away the `distDir` line would make the next update build straight over
 * the live `.next` — the exact failure the staging directory exists to prevent,
 * happening silently, once, on somebody's server.
 *
 * Checked after the reset and before the build, so what is inspected is the
 * version about to be built rather than the one that is running.
 */
export function configSupportsStagedBuild(source: string): boolean {
  return source.includes("RUNPANEL_DIST_DIR");
}

/**
 * What git actually said, with the command line taken off the front.
 *
 * `execFile` prefixes git's own words with the whole invocation, which is noise
 * on a screen that already says which repository it is talking about.
 *
 * Two cases get a sentence of their own because git's wording sends people
 * looking in the wrong place: a remote that refuses the request answers
 * "Repository not found" even when the repository plainly exists — GitHub says
 * that rather than "forbidden", so as not to confirm a private repository to a
 * stranger — and a remote that cannot be reached at all reads like a git
 * problem when it is a network one.
 *
 * Pure, so the unit suite can hold it against the real strings git emits.
 */
export function explainGitError(raw: string): string {
  const text = raw.replace(/^Command failed: [^\n]*\n?/, "").trim();

  if (
    /could not read Username|terminal prompts disabled|Authentication failed|Invalid username or password|[Rr]epository .*not found|Repository not found/.test(
      text
    )
  ) {
    return (
      "Il remote ha rifiutato la richiesta. Controlla che il repository esista ancora a " +
      "quell'indirizzo; se nel frattempo è diventato privato serve un account GitHub collegato " +
      "al pannello con accesso a questo repository."
    );
  }

  if (/Could not resolve host|unable to access|Connection timed out|Failed to connect/i.test(text)) {
    return `Il remote non è raggiungibile da questa macchina: ${text}`;
  }

  return text || "errore sconosciuto";
}

/**
 * Whether a signature git accepted is one the panel should act on.
 *
 * Exit status alone is not quite enough for GPG. A commit signed by a key that
 * is *present* in the keyring but carries no trust assignment verifies
 * successfully — `git verify-commit` exits 0 and prints a warning nobody reads.
 * For a control whose whole job is deciding what may run on this host, "I have
 * seen this key before" is not the same answer as "I trust this key", so
 * `TRUST_NEVER` and `TRUST_UNDEFINED` are rejected explicitly.
 *
 * SSH signatures do not produce those status lines at all — their trust model
 * is the allowed-signers file, which git has already applied by the time it
 * exits 0 — so they pass on the exit status, which is correct.
 *
 * Pure, so the unit suite can hold it against the real strings gpg emits.
 */
export function signatureAccepted(exitOk: boolean, raw: string): boolean {
  if (!exitOk) return false;
  return !/\bTRUST_(NEVER|UNDEFINED)\b/.test(raw);
}

/**
 * Why a signature was not accepted, in a sentence that says what to do next.
 *
 * The raw `--raw` output is gpg's machine-readable status protocol; showing it
 * to an operator who has just been told their update is refused is showing them
 * the wrong thing. Each case here is one an operator can actually act on.
 */
export function explainVerifyFailure(raw: string): string {
  const text = raw.replace(/^Command failed: [^\n]*\n?/, "").trim();

  if (/NO_PUBKEY|No public key|Can't check signature/i.test(text)) {
    return (
      "Il commit è firmato, ma questa macchina non ha la chiave pubblica per verificarlo. " +
      "Importa la chiave nel portachiavi dell'utente che esegue il pannello, oppure incolla " +
      "la chiave pubblica SSH fra i firmatari ammessi."
    );
  }

  if (/\bTRUST_(NEVER|UNDEFINED)\b/.test(text)) {
    return (
      "La firma è valida ma la chiave non è considerata attendibile su questa macchina. " +
      "Assegna un livello di fiducia alla chiave in GPG, oppure passa alla verifica SSH " +
      "elencandola fra i firmatari ammessi."
    );
  }

  if (/no signature found|NO_SIGNATURE/i.test(text)) {
    return (
      "Il commit da installare non è firmato. Firmalo alla sorgente, oppure disattiva la " +
      "verifica della firma nelle impostazioni degli aggiornamenti se non ti serve."
    );
  }

  if (/gpg.*not found|could not run gpg|ssh-keygen.*not found/i.test(text)) {
    return (
      "La verifica della firma è attiva ma lo strumento che la esegue non è installato su " +
      "questo host: serve gpg per le firme GPG, ssh-keygen per quelle SSH."
    );
  }

  return text
    ? `La firma del commit non è stata accettata: ${text}`
    : "La firma del commit non è stata accettata.";
}

/**
 * Why an update will not be fetched from this remote.
 *
 * The self-update resets the working tree to whatever the remote hands back and
 * then runs that tree's install scripts and its build. Over `http://` or
 * `git://` anybody on the network path chooses what runs on this host, and
 * `file://` is not a fetch at all — so the transport is refused before the
 * fetch rather than explained after it.
 */
export function insecureRemoteReason(remote: string): string {
  return (
    `Il remote di questo checkout non usa un trasporto sicuro (${remote}). ` +
    "Un aggiornamento scaricato da lì non è verificabile: chiunque sia sul percorso di rete " +
    "sceglierebbe che cosa viene eseguito su questa macchina. Passa il remote a https:// o ssh:// " +
    "con `git remote set-url origin`."
  );
}
