import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * What a project's environment receives from its linked services.
 *
 * This is the rule the operator reported as wrong, and until now it was only
 * reachable by running a real deploy against a real Docker daemon — which is
 * why the panel could describe it one way and do another for as long as it did.
 * `resolveServiceEnv` was extracted from the pipeline precisely so the whole
 * matrix is data in, data out.
 *
 * Standalone: no server, no daemon, so it runs on any machine — including one
 * where `--no-docker` would skip every suite that covers this behaviour.
 */
export const meta = { name: "service-link-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("service-link-unit");
  const { resolveServiceEnv, serviceEnvKey, suggestEnvKey, connectionEnvKey, reachesByContainerName } =
    await import(pathToFileURL(join(repoRoot, "lib", "service-env.ts")).href);

  const url = (svc) => `postgresql://user:pw@host:5432/${svc.name}`;
  const pg = (name, extra = {}) => ({ name, type: "postgresql", inject_env: 1, ...extra });

  // --- the key a link provides ---------------------------------------------
  r.check("default key comes from the type", serviceEnvKey({ type: "postgresql" }) === "DATABASE_URL");
  r.check("redis has its own", serviceEnvKey({ type: "redis" }) === "REDIS_URL");
  r.check("an explicit key wins", serviceEnvKey({ type: "postgresql", env_key: "ANALYTICS_URL" }) === "ANALYTICS_URL");
  r.check(
    "a blank explicit key falls back rather than injecting an empty name",
    serviceEnvKey({ type: "postgresql", env_key: "   " }) === "DATABASE_URL"
  );

  // --- the switch decides, not the value ------------------------------------
  {
    const env = {};
    const { applied } = resolveServiceEnv([pg("db")], env, url);
    r.check("an enabled link injects", env.DATABASE_URL === "postgresql://user:pw@host:5432/db");
    r.check("and reports what it did", applied.length === 1 && applied[0].key === "DATABASE_URL");
    r.check("without claiming it replaced anything", applied[0].replaced === false);
  }

  {
    const env = {};
    const { applied, skipped } = resolveServiceEnv([pg("db", { inject_env: 0 })], env, url);
    r.check("a disabled link injects nothing", env.DATABASE_URL === undefined);
    r.check("and is reported as skipped", skipped.length === 1 && applied.length === 0);
  }

  // The regression the operator hit: the project defines the variable, the link
  // is on, and the old code let the project's value win by accident.
  {
    const env = { DATABASE_URL: "postgresql://mia" };
    const { applied } = resolveServiceEnv([pg("db")], env, url);
    r.check(
      "an enabled link wins over a value set on the project",
      env.DATABASE_URL === "postgresql://user:pw@host:5432/db",
      env.DATABASE_URL
    );
    r.check("and says so, so the deploy log is not a surprise", applied[0].replaced === true);
  }

  // The old gate was `if (!envVars[key])`, so an empty string read as "not set"
  // while every screen said the opposite. Now presence is presence.
  {
    const env = { DATABASE_URL: "" };
    const { applied } = resolveServiceEnv([pg("db")], env, url);
    r.check("an empty project value is still a value that gets replaced", applied[0].replaced === true);
    r.check("and the connection string is the one that lands", env.DATABASE_URL.startsWith("postgresql://user"));
  }

  {
    const env = { DATABASE_URL: "postgresql://mia" };
    resolveServiceEnv([pg("db", { inject_env: 0 })], env, url);
    r.check(
      "switched off, the project's own value survives untouched",
      env.DATABASE_URL === "postgresql://mia"
    );
  }

  // --- two databases of the same type ---------------------------------------
  {
    const env = {};
    const { applied, conflicts } = resolveServiceEnv([pg("main"), pg("analytics")], env, url);
    r.check("a collision is reported rather than silently dropped", conflicts.length === 1);
    r.check("naming both services", conflicts[0].services.join(",") === "main,analytics");
    r.check("only the first one is applied", applied.length === 1 && applied[0].service === "main");
    r.check("and row order does not change the winner", env.DATABASE_URL.endsWith("/main"));
  }

  {
    const env = {};
    const { applied, conflicts } = resolveServiceEnv(
      [pg("main"), pg("analytics", { env_key: "ANALYTICS_DATABASE_URL" })],
      env,
      url
    );
    r.check("distinct keys mean no conflict", conflicts.length === 0);
    r.check("and both databases reach the app", applied.length === 2);
    r.check("each under its own name", env.DATABASE_URL.endsWith("/main") && env.ANALYTICS_DATABASE_URL.endsWith("/analytics"));
  }

  // A disabled link cannot collide with anything — it contributes no key.
  {
    const env = {};
    const { conflicts } = resolveServiceEnv([pg("main"), pg("analytics", { inject_env: 0 })], env, url);
    r.check("a switched-off link does not collide", conflicts.length === 0);
  }

  // --- the suggested name ----------------------------------------------------
  r.check("a suggestion is derived from the service name", suggestEnvKey("analytics", "postgresql") === "ANALYTICS_DATABASE_URL");
  r.check("punctuation becomes underscores", suggestEnvKey("read-replica", "postgresql") === "READ_REPLICA_DATABASE_URL");
  r.check("redis keeps its own suffix", suggestEnvKey("cache", "redis") === "CACHE_REDIS_URL");
  r.check(
    "a name that would start with a digit falls back to the plain key",
    suggestEnvKey("2nd", "postgresql") === connectionEnvKey("postgresql")
  );

  // --- which host the app actually reaches the service on -------------------
  {
    // Two places have to agree on this: the deploy builds the URL it injects
    // from it, and the service page shows the operator which line to copy. They
    // did not, and the difference was an app that could not resolve its
    // database — `could not translate host name "runpanel-svc-…"`.
    r.check("a container on the project network resolves by name", reachesByContainerName("docker", "project"));

    // No Docker DNS at all.
    r.check("a PM2 process does not", !reachesByContainerName("node", "project"));
    r.check("nor does a custom runtime", !reachesByContainerName("custom", "project"));
    r.check("nor a static one", !reachesByContainerName("static", "project"));

    // A container, but not on the network the service joined.
    r.check("a container on the default bridge does not", !reachesByContainerName("docker", "bridge"));
    r.check("nor one sharing the host stack", !reachesByContainerName("docker", "host"));

    // Compose publishes its own ports and the panel does not put its services
    // on that stack's network.
    r.check("nor a compose project", !reachesByContainerName("compose", "project"));
  }

  // --- both ways in have to agree ------------------------------------------
  // A project is started from two places: the deploy pipeline and
  // `restartFromLastDeployment` — the Restart button, a port change, and every
  // project the reconciler brings back after a reboot. Only the first injected
  // the linked service's connection string. Deploying worked, restarting handed
  // the app whatever was stored on the project, and the gap opened at reboot,
  // when nobody is watching.
  //
  // Asserted on the source because the behavioural version needs a Docker
  // daemon, a provisioned database and a project with a successful deploy
  // behind it — so it lives in the `service-link` suite, which is skipped on
  // every machine without Docker. This one runs everywhere and fails the moment
  // either path starts building its own environment again.
  {
    const read = async (...parts) =>
      (await import("node:fs")).readFileSync(join(repoRoot, ...parts), "utf8");

    const restart = await read("services", "project-restart.ts");
    const pipeline = await read("services", "deploy-pipeline.ts");

    r.check(
      "the restart path injects linked services",
      /injectLinkedServiceEnv\s*\(/.test(restart)
    );
    r.check(
      "the deploy path injects linked services",
      /injectLinkedServiceEnv\s*\(/.test(pipeline)
    );
    // One implementation, not two that look alike until one of them is edited.
    r.check(
      "neither builds the injection itself",
      !/resolveServiceEnv\s*\(/.test(restart) && !/resolveServiceEnv\s*\(/.test(pipeline)
    );
  }

  return r.result();
}
