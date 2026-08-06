import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Pure checks on the contract parser — no server involved.
 *
 * Backward compatibility is worth testing rather than assuming: existing
 * projects store the pre-contract four-field shape, and the schema strips keys
 * it does not recognise, so a missing normalisation step silently empties a
 * project's configuration.
 */
export const meta = { name: "contract-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("contract-unit");

  const module = await import(
    pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href
  );
  const { parseContract, parseContractJson, resolveContract, selectBuildEnv, preflight } = module;

  // --- legacy shape --------------------------------------------------------
  const legacy = parseContract({
    installCmd: "npm ci",
    buildCmd: "npm run build",
    startCmd: "npm start",
    packageManager: "npm",
    dockerImage: "nginx:1.27",
  });
  r.check("legacy install command migrated", legacy.commands.install === "npm ci", legacy.commands.install);
  r.check("legacy build command migrated", legacy.commands.build === "npm run build", legacy.commands.build);
  r.check("legacy start command migrated", legacy.commands.start === "npm start", legacy.commands.start);
  r.check("legacy package manager kept", legacy.packageManager === "npm", legacy.packageManager);
  r.check("legacy docker image kept", legacy.docker.image === "nginx:1.27", legacy.docker.image);
  r.check("legacy config still receives defaults", legacy.healthcheck.enabled === true);

  // --- resilience ----------------------------------------------------------
  r.check("empty config yields defaults", parseContractJson("").healthcheck.path === "/");
  r.check("invalid JSON yields defaults", parseContractJson("{not json").runtime.restartPolicy === "unless-stopped");
  r.check("null yields defaults", parseContract(null).build.timeoutSec === 900);

  // --- build env selection -------------------------------------------------
  const contract = parseContract({ version: 1, buildEnv: { EXPLICIT: "yes" } });
  const selected = selectBuildEnv(contract, {
    NEXT_PUBLIC_BASE_URL: "https://x",
    VITE_KEY: "v",
    SECRET: "nope",
    EXPLICIT: "overridden",
  });
  r.check("NEXT_PUBLIC_* is forwarded to the build", selected.NEXT_PUBLIC_BASE_URL === "https://x");
  r.check("VITE_* is forwarded to the build", selected.VITE_KEY === "v");
  r.check("a non-prefixed runtime secret is NOT sent to the build",
    !("SECRET" in selected), JSON.stringify(selected));
  r.check("an explicit buildEnv entry wins", selected.EXPLICIT === "yes", selected.EXPLICIT);

  // --- repo contract merge -------------------------------------------------
  // Merged RAW, before defaults: once a default has been applied there is no
  // way to tell "the operator chose 3" from "nobody set it", and the repository
  // could never contribute a value to any field that has one.
  const merged = resolveContract(
    { version: 1, healthcheck: { path: "/panel-wins" } },
    { version: 1, healthcheck: { path: "/repo-says", startPeriodSec: 42 }, commands: { release: "npx prisma db push" } }
  );
  r.check("the panel's setting beats the repository's",
    merged.healthcheck.path === "/panel-wins", merged.healthcheck.path);
  r.check("the repository fills in what the panel left unset",
    merged.healthcheck.startPeriodSec === 42, String(merged.healthcheck.startPeriodSec));
  r.check("the repository can contribute a release command",
    merged.commands.release === "npx prisma db push", merged.commands.release);

  // --- preflight -----------------------------------------------------------
  const emptyArg = preflight(
    parseContract({ version: 1, buildEnv: { NEXT_PUBLIC_BASE_URL: "" } }),
    { runtimeType: "docker", envVars: {} }
  );
  r.check("an empty build arg is flagged before the build starts",
    emptyArg.some((i) => i.field === "buildEnv.NEXT_PUBLIC_BASE_URL"), JSON.stringify(emptyArg));

  const nativeIssues = preflight(
    parseContract({ version: 1, docker: { network: "host" } }),
    { runtimeType: "node", envVars: {} }
  );
  r.check("a container-only option is flagged on a native runtime",
    nativeIssues.some((i) => i.field === "docker.network"), JSON.stringify(nativeIssues));

  return r.result();
}
