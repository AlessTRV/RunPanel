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
  const {
    resolveServiceEnv,
    serviceEnvKey,
    suggestEnvKey,
    connectionEnvKey,
    connectionOrigin,
    serviceConnectionUrl,
    containerPort,
    maskUrlPassword,
  } = await import(pathToFileURL(join(repoRoot, "lib", "service-env.ts")).href);

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
    // from it, and the service page shows the operator which line to copy.
    // Inside a container `localhost` is the container itself, and
    // `host.docker.internal` is a host-gateway address that a firewall on the
    // host is free to drop — the one address that always works from a
    // container is the service's name on the project network.
    r.check("a docker app resolves by container name", connectionOrigin("docker", "project") === "container");
    r.check("even when its contract asks for the default bridge", connectionOrigin("docker", "bridge") === "container");
    r.check("a compose stack resolves by container name", connectionOrigin("compose", "project") === "container");
    r.check("a container sharing the host stack uses the host", connectionOrigin("docker", "host") === "host");
    r.check("and so does a compose stack on network_mode host", connectionOrigin("compose", "host") === "host");

    // No Docker DNS at all.
    r.check("a PM2 process uses the host", connectionOrigin("node", "project") === "host");
    r.check("so does a custom runtime", connectionOrigin("custom", "project") === "host");
    r.check("and a static one", connectionOrigin("static", "project") === "host");
    r.check("with no contract at all a native runtime still uses the host", connectionOrigin("node") === "host");
  }

  // --- the URL that lands in the app's environment ---------------------------
  {
    const creds = { user: "app", password: "s3cret", database: "shop" };
    const svc = (type) => ({
      type,
      port: 5433, // published on the host, deliberately not the default
      containerName: "runpanel-svc-tgshop-shop",
      credentials: type === "redis" ? { password: "s3cret" } : creds,
    });
    const url = (type, runtime, network = "project") =>
      serviceConnectionUrl(svc(type), { runtime_type: runtime, dockerNetwork: network });

    // Inside the network the published mapping does not exist: the service
    // listens on the port its image exposes, whatever the host publishes.
    const inside = {
      postgresql: "postgresql://app:s3cret@runpanel-svc-tgshop-shop:5432/shop",
      mysql: "mysql://app:s3cret@runpanel-svc-tgshop-shop:3306/shop",
      redis: "redis://:s3cret@runpanel-svc-tgshop-shop:6379/0",
      mongodb: "mongodb://app:s3cret@runpanel-svc-tgshop-shop:27017/shop?authSource=admin",
    };
    const outside = {
      postgresql: "postgresql://app:s3cret@localhost:5433/shop",
      mysql: "mysql://app:s3cret@localhost:5433/shop",
      redis: "redis://:s3cret@localhost:5433/0",
      mongodb: "mongodb://app:s3cret@localhost:5433/shop?authSource=admin",
    };

    for (const type of Object.keys(inside)) {
      r.check(`${type}: a docker project gets the container name`, url(type, "docker") === inside[type], url(type, "docker"));
      r.check(`${type}: a compose project gets the container name`, url(type, "compose") === inside[type], url(type, "compose"));
      // Unchanged from before: a native project must keep the exact URL it
      // has always received.
      r.check(`${type}: a node project keeps localhost and the published port`, url(type, "node") === outside[type], url(type, "node"));
      r.check(`${type}: so does a custom runtime`, url(type, "custom") === outside[type], url(type, "custom"));
    }

    r.check("a docker app on network: host is reached like a native one", url("postgresql", "docker", "host") === outside.postgresql);
    r.check(
      "the caller can force the viewpoint",
      serviceConnectionUrl(svc("postgresql"), { runtime_type: "docker" }, { from: "host" }) === outside.postgresql
    );
    r.check("a service with no project is described from the host", serviceConnectionUrl(svc("postgresql"), null) === outside.postgresql);
    r.check(
      "an explicit internal port wins over the type's default",
      serviceConnectionUrl({ ...svc("postgresql"), internalPort: 6543 }, { runtime_type: "docker" }).includes(":6543/")
    );

    // The port a service listens on inside its container, per type.
    r.check("postgres listens on 5432", containerPort("postgresql") === 5432);
    r.check("mysql on 3306", containerPort("mysql") === 3306);
    r.check("redis on 6379", containerPort("redis") === 6379);
    r.check("mongodb on 27017", containerPort("mongodb") === 27017);
  }

  // --- the deploy log shows the host, never the password ---------------------
  {
    r.check(
      "a password is masked",
      maskUrlPassword("postgresql://app:s3cret@runpanel-svc-x:5432/db") === "postgresql://app:***@runpanel-svc-x:5432/db",
      maskUrlPassword("postgresql://app:s3cret@runpanel-svc-x:5432/db")
    );
    r.check(
      "a redis URL with no user is masked too",
      maskUrlPassword("redis://:s3cret@localhost:6379/0") === "redis://:***@localhost:6379/0",
      maskUrlPassword("redis://:s3cret@localhost:6379/0")
    );
    r.check("a URL without credentials is left alone", maskUrlPassword("redis://localhost:6379/0") === "redis://localhost:6379/0");
    r.check(
      "a password containing @ is still fully hidden",
      maskUrlPassword("mysql://u:p@ss@host:3306/d") === "mysql://u:***@host:3306/d",
      maskUrlPassword("mysql://u:p@ss@host:3306/d")
    );
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
