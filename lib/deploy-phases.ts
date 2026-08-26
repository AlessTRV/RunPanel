/**
 * The points of a deploy at which a one-time command can be pinned.
 *
 * ARRAY ORDER IS EXECUTION ORDER, and that is load-bearing twice over: the
 * settings form renders the picker in this order, and the deploy pipeline's
 * eight call sites are expected to match it. Reordering this array without
 * moving those call sites makes the interface describe a sequence that does not
 * happen.
 *
 * No imports on purpose. This list is read by the deploy pipeline, by a Zod
 * schema in `lib/validation.ts`, by a client component and by a standalone test
 * that loads the file directly — and the third of those is what an import from
 * `services/` would break. `runtimeType` is therefore a plain `string` rather
 * than `RuntimeType`: that type lives in `lib/validation.ts`, which imports
 * `deployPhases` from here, and taking it back would close a cycle.
 */

export const deployPhases = [
  "pre-deploy",
  "post-source",
  "pre-install",
  "post-install",
  "post-build",
  "pre-start",
  "post-start",
  "post-deploy",
] as const;

export type DeployPhase = (typeof deployPhases)[number];

/**
 * The two phases the builders own rather than the pipeline.
 *
 * Narrowed as its own type so a builder cannot be handed a phase it does not
 * run: `BuildContext.onPhase` takes this, not `DeployPhase`.
 */
export type BuildPhase = Extract<DeployPhase, "pre-install" | "post-install">;

export interface DeployPhaseInfo {
  id: DeployPhase;
  /** Short enough to sit in a picker next to seven others. */
  label: string;
  /** Exactly where it lands, and what is true at that moment. */
  description: string;
}

export const DEPLOY_PHASES: readonly DeployPhaseInfo[] = [
  {
    id: "pre-deploy",
    label: "Prima del deploy",
    description:
      "Prima che venga toccato qualsiasi cosa: sul disco c'è ancora il codice dell'ultimo deploy e l'app vecchia sta girando.",
  },
  {
    id: "post-source",
    label: "Dopo il git",
    description:
      "Il nuovo commit è sul disco e le variabili sono caricate, ma non è stato installato né costruito niente. L'app vecchia è ancora in piedi.",
  },
  {
    id: "pre-install",
    label: "Prima dell'install",
    description: "Subito prima dell'installazione delle dipendenze.",
  },
  {
    id: "post-install",
    label: "Dopo l'install",
    description: "Dipendenze installate, build non ancora eseguito.",
  },
  {
    id: "post-build",
    label: "Dopo il build",
    description:
      "Build riuscito, prima del release command e prima che l'app vecchia venga fermata.",
  },
  {
    id: "pre-start",
    label: "Prima dell'avvio",
    description:
      "Il processo vecchio è già fermo e quello nuovo non è ancora partito: in questo momento l'app non sta servendo.",
  },
  {
    id: "post-start",
    label: "Dopo l'avvio",
    description:
      "Il processo nuovo è stato avviato ma l'health check non è ancora passato: potrebbe non rispondere ancora.",
  },
  {
    id: "post-deploy",
    label: "A deploy riuscito",
    description:
      "Health check passato. Se questo comando fallisce, il deploy viene registrato come fallito anche se l'app sta servendo.",
  },
];

/**
 * Where a new row starts.
 *
 * The safest slot of the eight: il build è fatto, quindi il comando gira su
 * qualcosa di funzionante, e l'app vecchia non è ancora stata sostituita.
 */
export const DEFAULT_PHASE: DeployPhase = "post-build";

/**
 * Why this phase does not exist for this runtime, or `null` if it does.
 *
 * One clause, not a per-runtime table: under Docker install and build are a
 * single `docker build`, so there is no moment between them to pin anything to.
 * Offering the slot anyway would agganciare il comando a un punto che non c'è.
 *
 * A **static** project keeps both, deliberately: `staticBuilder` has no install
 * step, so the two run consecutively just before the build command. The slot is
 * still useful — `apt-get install imagemagick` before a build is exactly it —
 * and the alternative is an exception nobody remembers.
 */
export function phaseUnavailableReason(phase: DeployPhase, runtimeType: string): string | null {
  const containerised = runtimeType === "docker" || runtimeType === "compose";
  if (containerised && (phase === "pre-install" || phase === "post-install")) {
    return (
      `Con il runtime ${runtimeType} install e build sono un unico passo dentro l'immagine: ` +
      `non c'è un momento fra i due. Usa "Dopo il git" oppure "Dopo il build".`
    );
  }
  return null;
}

export function phaseAvailable(phase: DeployPhase, runtimeType: string): boolean {
  return phaseUnavailableReason(phase, runtimeType) === null;
}

export function phasesFor(runtimeType: string): DeployPhaseInfo[] {
  return DEPLOY_PHASES.filter((phase) => phaseAvailable(phase.id, runtimeType));
}

/**
 * The label for a stored phase string.
 *
 * Falls back to the id rather than to an empty string: a row written before a
 * phase was renamed must still render as something a person can act on.
 */
export function phaseLabel(phase: string): string {
  return DEPLOY_PHASES.find((entry) => entry.id === phase)?.label ?? phase;
}

/**
 * Where a command pinned here actually runs.
 *
 * Only Docker has a second answer, and only once its image exists — which is
 * why the two phases before the build are host-side even there. It is the same
 * rule `runReleaseCommand` already applies; this function only states it early
 * enough for the form to say it before the deploy does.
 *
 * Compose is host-side throughout: `composeBuilder` produces no single image a
 * throwaway container could be made from, and only the operator knows which
 * service they meant.
 */
export function phaseRunsInContainer(phase: DeployPhase, runtimeType: string): boolean {
  if (runtimeType !== "docker") return false;
  return phase === "post-build" || phase === "pre-start" || phase === "post-start" || phase === "post-deploy";
}
