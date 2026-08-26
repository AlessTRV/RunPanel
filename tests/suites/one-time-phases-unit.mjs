import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The phase table, on its own — no server, no database.
 *
 * `lib/deploy-phases.ts` is imported directly, which only works because it has
 * no imports of its own. That is not an accident of this test: the same file is
 * read by a client component, by a Zod schema and by the deploy pipeline, and
 * the day it grows an import from `services/` the panel stops building and this
 * suite stops loading.
 *
 * The order of `deployPhases` is asserted because it is load-bearing twice: the
 * picker renders it, and the pipeline's eight call sites are meant to match it.
 */
export const meta = { name: "one-time-phases-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("one-time-phases-unit");

  const module = await import(pathToFileURL(join(repoRoot, "lib", "deploy-phases.ts")).href);
  const {
    deployPhases,
    DEPLOY_PHASES,
    DEFAULT_PHASE,
    phaseAvailable,
    phaseUnavailableReason,
    phaseLabel,
    phasesFor,
    phaseRunsInContainer,
  } = module;

  // --- the list itself -------------------------------------------------------
  const expected = [
    "pre-deploy",
    "post-source",
    "pre-install",
    "post-install",
    "post-build",
    "pre-start",
    "post-start",
    "post-deploy",
  ];
  r.check(
    "eight phases, in deploy order",
    JSON.stringify([...deployPhases]) === JSON.stringify(expected),
    JSON.stringify([...deployPhases])
  );

  // Drift between the ids and their metadata would give the picker a blank row.
  r.check(
    "every phase has metadata, and nothing extra does",
    DEPLOY_PHASES.length === deployPhases.length &&
      DEPLOY_PHASES.every((entry, i) => entry.id === deployPhases[i]) &&
      DEPLOY_PHASES.every((entry) => entry.label && entry.description),
    JSON.stringify(DEPLOY_PHASES.map((entry) => entry.id))
  );

  r.check("the default is a real phase", deployPhases.includes(DEFAULT_PHASE), DEFAULT_PHASE);

  // --- availability ----------------------------------------------------------
  for (const runtime of ["docker", "compose"]) {
    for (const phase of ["pre-install", "post-install"]) {
      r.check(
        `${phase} does not exist for ${runtime}`,
        phaseAvailable(phase, runtime) === false,
        `${phase}/${runtime}`
      );
      const reason = phaseUnavailableReason(phase, runtime);
      r.check(
        `${phase}/${runtime} explains itself`,
        typeof reason === "string" && reason.length > 20,
        String(reason)
      );
    }
  }

  for (const runtime of ["node", "custom", "static"]) {
    r.check(
      `pre-install exists for ${runtime}`,
      phaseAvailable("pre-install", runtime) === true,
      runtime
    );
  }

  // Everything else is available everywhere: the only rule is the container one.
  const others = expected.filter((phase) => phase !== "pre-install" && phase !== "post-install");
  r.check(
    "the other six phases exist for every runtime",
    ["node", "static", "custom", "docker", "compose"].every((runtime) =>
      others.every((phase) => phaseAvailable(phase, runtime))
    ),
    "container rule leaked"
  );

  r.check("phasesFor(docker) drops exactly two", phasesFor("docker").length === 6, String(phasesFor("docker").length));
  r.check("phasesFor(node) keeps all eight", phasesFor("node").length === 8, String(phasesFor("node").length));

  // --- where a command actually runs ----------------------------------------
  r.check(
    "docker runs post-build phases in a container",
    ["post-build", "pre-start", "post-start", "post-deploy"].every((phase) =>
      phaseRunsInContainer(phase, "docker")
    ),
    "container phases"
  );
  r.check(
    "docker runs the pre-image phases on the host",
    ["pre-deploy", "post-source"].every((phase) => !phaseRunsInContainer(phase, "docker")),
    "there is no image yet"
  );
  r.check(
    "compose never uses a container",
    expected.every((phase) => !phaseRunsInContainer(phase, "compose")),
    "compose builds no single image"
  );
  r.check(
    "native runtimes never use a container",
    expected.every((phase) => !phaseRunsInContainer(phase, "node")),
    "node"
  );

  // --- labels ----------------------------------------------------------------
  r.check("a known phase gets its label", phaseLabel("post-build") === "Dopo il build", phaseLabel("post-build"));
  // A row written before a rename must still render as something actionable.
  r.check("an unknown phase falls back to its id", phaseLabel("nope") === "nope", phaseLabel("nope"));

  return r.result();
}
