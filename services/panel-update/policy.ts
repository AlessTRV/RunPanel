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
