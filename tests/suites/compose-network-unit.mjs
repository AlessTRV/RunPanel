import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * The override that puts a compose stack on the project network.
 *
 * A compose project used to run on the network compose made for it, and the
 * panel's services on `runpanel-net-<slug>`: two networks, no route between
 * them, and an injected `DATABASE_URL` that could never connect. The override
 * is generated from the resolved compose config and passed as a second `-f`,
 * so the user's file is never rewritten.
 *
 * Pure: the resolved config is what `docker compose config --format json`
 * prints, and the override is text — so this runs without a daemon.
 */
export const meta = { name: "compose-network-unit", needsDocker: false, drivers: [], standalone: true };

/** js-yaml ships with the lint toolchain; if it is ever gone, JSON is still YAML. */
function parseYaml(text) {
  try {
    const yaml = createRequire(import.meta.url)("js-yaml");
    return yaml.load(text);
  } catch (err) {
    if (err?.code === "MODULE_NOT_FOUND") return JSON.parse(text);
    throw err;
  }
}

export async function run({ repoRoot }) {
  const r = createReporter("compose-network-unit");
  const { composeNetworkOverride } = await import(
    pathToFileURL(join(repoRoot, "lib", "compose-network.ts")).href
  );

  // What `config --format json` prints for a two-service file with no
  // networks section: every service is on the implicit default network.
  const plain = {
    name: "runpanel-tgshop",
    services: {
      web: { image: "web", networks: { default: null } },
      worker: { image: "worker", networks: { default: null } },
    },
    networks: { default: { name: "runpanel-tgshop_default" } },
  };

  {
    const override = composeNetworkOverride(plain, "tgshop");
    r.check("an override is produced", override !== null);
    r.check("it attaches every service", override.attached.join(",") === "web,worker", override.attached.join(","));
    r.check("and skips none", override.skipped.length === 0);

    let doc = null;
    try {
      doc = parseYaml(override.text);
    } catch (err) {
      r.check("the override is valid YAML", false, String(err));
    }
    if (doc) {
      r.check("the override is valid YAML", typeof doc === "object");
      r.check("it declares the project network as external", doc.networks?.runpanel?.external === true, JSON.stringify(doc.networks));
      r.check("under its real name", doc.networks?.runpanel?.name === "runpanel-net-tgshop", JSON.stringify(doc.networks));
      r.check("web joins it", Object.hasOwn(doc.services?.web?.networks ?? {}, "runpanel"), JSON.stringify(doc.services?.web));
      r.check("worker joins it", Object.hasOwn(doc.services?.worker?.networks ?? {}, "runpanel"));
      // A service with no explicit networks is on `default` only because the
      // list is empty. Once the override names a network, `default` has to be
      // named too or the stack loses the network its own services talk over.
      r.check(
        "and both keep the default network",
        Object.hasOwn(doc.services.web.networks, "default") && Object.hasOwn(doc.services.worker.networks, "default")
      );
      r.check("no other key is touched", Object.keys(doc.services.web).join(",") === "networks", Object.keys(doc.services.web).join(","));
    }
  }

  // A stack with its own networks keeps them, plus the panel's.
  {
    const custom = {
      services: {
        api: { image: "api", networks: { backend: { aliases: ["api-internal"] }, frontend: null } },
        db: { image: "postgres", networks: { backend: null } },
      },
      networks: { backend: { name: "x_backend" }, frontend: { name: "x_frontend" } },
    };
    const doc = parseYaml(composeNetworkOverride(custom, "shop").text);
    r.check(
      "a service's own networks are all still named",
      Object.keys(doc.services.api.networks).sort().join(",") === "backend,frontend,runpanel",
      JSON.stringify(doc.services.api.networks)
    );
    r.check(
      "without restating their options, which the base file owns",
      doc.services.api.networks.backend === null || Object.keys(doc.services.api.networks.backend).length === 0,
      JSON.stringify(doc.services.api.networks.backend)
    );
    r.check("a service without default does not get one added", !Object.hasOwn(doc.services.db.networks, "default"));
  }

  // `network_mode` and `networks` are mutually exclusive in compose, so a
  // service on the host stack cannot be attached and must not appear.
  {
    const mixed = {
      services: {
        web: { image: "web", networks: { default: null } },
        agent: { image: "agent", network_mode: "host" },
        sidecar: { image: "sc", network_mode: "service:web" },
      },
    };
    const override = composeNetworkOverride(mixed, "tgshop");
    r.check("a host-networked service is skipped", override.skipped.join(",") === "agent,sidecar", override.skipped.join(","));
    r.check("and named, so the deploy log can say so", override.attached.join(",") === "web");
    const doc = parseYaml(override.text);
    r.check(
      "it is absent from the override entirely",
      !Object.hasOwn(doc.services, "agent") && !Object.hasOwn(doc.services, "sidecar")
    );
  }

  {
    const allHost = { services: { web: { image: "web", network_mode: "host" } } };
    const override = composeNetworkOverride(allHost, "tgshop");
    r.check("a stack entirely on the host network gets no override", override === null);
  }

  {
    r.check("a config with no services gets no override", composeNetworkOverride({ services: {} }, "x") === null);
    r.check("nor does one with the section missing", composeNetworkOverride({}, "x") === null);
  }

  return r.result();
}
