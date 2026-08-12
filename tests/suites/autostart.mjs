import { createReporter, client, SETUP_TOKEN } from "../harness.mjs";

/**
 * The autostart API against a running panel.
 *
 * The probe has to answer coherently on whatever machine the suite runs on —
 * Windows without systemd included — because a probe that throws on an
 * unexpected host tells you nothing about the six other things it checks. The
 * reconciler is exercised in dry-run, which is exactly what the "Simula" button
 * does and is safe anywhere.
 */
export const meta = { name: "autostart", needsDocker: false, drivers: ["sqlite"] };

const PASSWORD = "autostart-suite-password";

export async function run({ base }) {
  const r = createReporter("autostart");
  const api = client(base);

  for (const [method, route] of [
    ["GET", "/api/autostart"],
    ["POST", "/api/autostart/reconcile"],
    ["POST", "/api/autostart/host"],
    ["POST", "/api/autostart/fix"],
  ]) {
    const { status } = await api.call(route, {
      method,
      ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
    });
    r.check(`${method} ${route} requires a session`, status === 401, String(status));
  }

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: PASSWORD, confirmPassword: PASSWORD }),
  });

  // --- the probe answers on any host ---------------------------------------
  const probed = await api.call("/api/autostart");
  r.check("the probe answers", probed.status === 200, String(probed.status));

  const probe = probed.body?.probe;
  r.check("it names a method", typeof probe?.recommended === "string", probe?.recommended);
  r.check(
    "it explains the choice rather than only stating it",
    (probe?.recommendedReason ?? "").length > 20,
    probe?.recommendedReason
  );
  r.check("it reports the platform", typeof probe?.environment?.platform === "string");
  r.check("it reports whether it is containerised", typeof probe?.environment?.containerised === "boolean");
  r.check("it checks systemd without assuming it exists", typeof probe?.systemd?.available === "boolean");
  r.check("it checks cron the same way", typeof probe?.cron?.available === "boolean");
  r.check("it checks whether Docker itself starts at boot", "enabledAtBoot" in (probe?.docker ?? {}));
  r.check("it checks whether PM2 would resurrect anything", typeof probe?.pm2?.dumpSaved === "boolean");
  r.check(
    "the port it listens on shows as occupied, because it is listening",
    probe?.port?.free === false,
    JSON.stringify(probe?.port)
  );
  r.check(
    "the schedulers are off in the test harness, and it says so",
    probed.body?.reconcilerEnabled === false
  );

  // --- entries -------------------------------------------------------------
  r.check("the entry list is present", Array.isArray(probed.body?.entries));
  r.check("nothing has run yet, so there is no boot report", probed.body?.report === null);

  // --- a project takes its defaults ----------------------------------------
  const project = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Autostart demo" }),
  });
  r.check("a project can be created", project.status === 201, JSON.stringify(project.body));

  const withProject = await api.call("/api/autostart");
  const entry = withProject.body?.entries?.find((candidate) => candidate.id === project.body.id);
  r.check("it appears in the autostart list", Boolean(entry), JSON.stringify(entry));
  // A project has to be asked for explicitly; a database defaults to on.
  r.check("a new project does not autostart by default", entry?.autostart === false);
  r.check("it comes with an order", entry?.order === 100, String(entry?.order));
  r.check("and with no wait", entry?.waitHealthy === false);

  // --- turning it on --------------------------------------------------------
  const saved = await api.call("/api/autostart", {
    method: "PUT",
    body: JSON.stringify({
      entries: [
        { kind: "project", id: project.body.id, autostart: true, order: 10, delaySeconds: 3, waitHealthy: true },
      ],
    }),
  });
  r.check("preferences save", saved.status === 200, String(saved.status));

  const after = await api.call("/api/autostart");
  const updated = after.body?.entries?.find((candidate) => candidate.id === project.body.id);
  r.check("the switch stuck", updated?.autostart === true);
  r.check("the order stuck", updated?.order === 10, String(updated?.order));
  r.check("the delay stuck", updated?.delaySeconds === 3, String(updated?.delaySeconds));

  const rejected = await api.call("/api/autostart", {
    method: "PUT",
    body: JSON.stringify({
      entries: [{ kind: "project", id: project.body.id, autostart: true, delaySeconds: 99999 }],
    }),
  });
  r.check("an absurd delay is refused", rejected.status === 400, String(rejected.status));

  // --- the dry run ----------------------------------------------------------
  const dry = await api.call("/api/autostart/reconcile", {
    method: "POST",
    body: JSON.stringify({ dryRun: true }),
  });
  r.check("a simulation runs", dry.status === 200, JSON.stringify(dry.body?.error));
  r.check("it is marked as a simulation", dry.body?.dryRun === true);
  r.check(
    "it considers the project we switched on",
    dry.body?.entries?.some((candidate) => candidate.id === project.body.id),
    JSON.stringify(dry.body?.entries)
  );
  r.check(
    "and does not claim to have started anything",
    dry.body?.started === 0,
    String(dry.body?.started)
  );

  // A dry run is a question, not an event: it must not become the record of
  // what happened at the last boot.
  const stillNoReport = await api.call("/api/autostart");
  r.check("a simulation does not overwrite the boot report", stillNoReport.body?.report === null);

  // --- the host side --------------------------------------------------------
  const preview = await api.call("/api/autostart/host", {
    method: "POST",
    body: JSON.stringify({ action: "preview" }),
  });
  r.check("a preview is always available", preview.status === 200, String(preview.status));
  r.check("it explains what it would do", (preview.body?.plan?.reason ?? "").length > 10, preview.body?.plan?.reason);
  r.check(
    "on a host it cannot configure, it says so instead of failing",
    typeof preview.body?.plan?.canInstall === "boolean",
    JSON.stringify(preview.body?.plan?.canInstall)
  );

  const badAction = await api.call("/api/autostart/host", {
    method: "POST",
    body: JSON.stringify({ action: "reboot-the-world" }),
  });
  r.check("an unknown action is refused", badAction.status === 400, String(badAction.status));

  const badFix = await api.call("/api/autostart/fix", {
    method: "POST",
    body: JSON.stringify({ fix: "restart-policy" }),
  });
  r.check("a restart-policy fix without a target is refused", badFix.status === 400, String(badFix.status));

  return r.result();
}
