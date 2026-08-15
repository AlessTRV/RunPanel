import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The files the autostart feature writes onto a host, checked without a host.
 *
 * Everything here is a pure function of an input object, which is the point:
 * these are the bytes that decide whether a machine comes back after a reboot,
 * and they should be verifiable on a laptop rather than only on the server
 * where getting them wrong costs a night.
 */
export const meta = { name: "autostart-unit", needsDocker: false, drivers: [], standalone: true };

const INPUT = {
  nodePath: "/usr/local/bin/node",
  nextBin: "/srv/runpanel/node_modules/next/dist/bin/next",
  workingDirectory: "/srv/runpanel",
  user: "runpanel",
  port: 3000,
  dataDir: "/srv/runpanel/data",
  envFile: "/srv/runpanel/.env",
  pathEnv: "/usr/local/bin:/usr/bin:/bin:/home/runpanel/.bun/bin",
};

export async function run({ repoRoot }) {
  const r = createReporter("autostart-unit");

  const { renderUnit, renderStartScript, crontabLine, installCommands, shellQuote, UNIT_PATH } =
    await import(pathToFileURL(join(repoRoot, "services", "autostart", "render.ts")).href);

  const unit = renderUnit(INPUT);

  // --- the unit ------------------------------------------------------------
  r.check("it is a systemd unit", unit.startsWith("[Unit]"));
  r.check("it installs into multi-user", unit.includes("WantedBy=multi-user.target"));

  // npm between systemd and the server breaks signal delivery: PID 1 signals
  // npm, and the process that has to shut down cleanly never hears about it.
  r.check("it never goes through npm", !/ExecStart=.*npm/.test(unit), unit.match(/ExecStart=.*/)?.[0]);
  r.check(
    "ExecStart uses absolute paths",
    unit.includes(`ExecStart=${INPUT.nodePath} ${INPUT.nextBin} start -p 3000`),
    unit.match(/ExecStart=.*/)?.[0]
  );

  // Every feature needs Docker; ordering after it is not enough if it might not
  // be there at all.
  r.check("it requires docker, not merely orders after it", unit.includes("Requires=docker.service"));
  r.check("it orders after docker and the network", unit.includes("After=network-online.target docker.service"));

  // The leading dash is what makes a missing .env a non-event rather than a
  // failed boot.
  r.check(
    "a missing .env does not stop the boot",
    unit.includes(`EnvironmentFile=-${INPUT.envFile}`),
    unit.match(/EnvironmentFile=.*/)?.[0]
  );

  // A unit file is world-readable and the key decrypts every stored credential.
  r.check("the encryption key is never written into it", !/RUNPANEL_SECRET/.test(unit));

  r.check("it restarts on failure", unit.includes("Restart=always"));
  r.check("it shuts down with SIGINT, which next handles", unit.includes("KillSignal=SIGINT"));
  // ~/.pm2 and the Docker socket have to stay reachable.
  r.check("home stays reachable", unit.includes("ProtectHome=no"));
  r.check("it runs as the resolved user", unit.includes(`User=${INPUT.user}`));
  r.check("the data directory is passed explicitly", unit.includes(`RUNPANEL_DATA_DIR=${INPUT.dataDir}`));

  // --- PATH ----------------------------------------------------------------
  // systemd gives a unit PID 1's PATH: no ~/.bun/bin, no nvm directory. The
  // panel starts anyway — ExecStart is absolute — and then every build command
  // it runs exits 127 with `bun: command not found`, which reads as a broken
  // build command rather than a broken environment. This one line is the
  // difference between autostart working and autostart looking like it works.
  r.check(
    "the toolchain PATH is written into the unit",
    unit.includes(`Environment="PATH=${INPUT.pathEnv}"`),
    unit.match(/Environment="PATH=.*/)?.[0] ?? "no PATH line"
  );
  // Unquoted, systemd splits the assignment on whitespace and everything after
  // the first space is dropped — a silently truncated PATH.
  r.check(
    "it is quoted, so a directory with a space in it survives",
    renderUnit({ ...INPUT, pathEnv: "/opt/my tools/bin:/usr/bin" }).includes(
      `Environment="PATH=/opt/my tools/bin:/usr/bin"`
    )
  );
  // Older callers, and the tests above this file's own change, pass no PATH.
  r.check(
    "a caller that supplies none gets no empty PATH line",
    !/Environment="?PATH=/.test(renderUnit({ ...INPUT, pathEnv: undefined }))
  );

  // --- the cron path -------------------------------------------------------
  const script = renderStartScript(INPUT, "/srv/runpanel/data/logs/autostart.log");
  r.check("the script is a shell script", script.startsWith("#!/bin/sh"));
  r.check("it changes into the working directory", script.includes("cd '/srv/runpanel'"));
  // cron has no Restart=, so the script has to supervise or a crash is final.
  r.check("it supervises, because cron will not", script.includes("while true; do") && script.includes("sleep 5"));
  r.check("it redirects to a log", script.includes("autostart.log"));
  // cron's PATH is /usr/bin:/bin, narrower still than systemd's.
  r.check(
    "the script exports the toolchain PATH too",
    script.includes(`export PATH='${INPUT.pathEnv}'`),
    script.split("\n").find((line) => line.startsWith("export PATH")) ?? "no PATH export"
  );
  // .env is sourced first, so a PATH set there would otherwise win and the
  // export would be pointless.
  r.check(
    "it exports PATH after sourcing .env, not before",
    script.indexOf("export PATH") > script.indexOf(INPUT.envFile)
  );

  r.check(
    "the crontab line points at the script, not at a pipeline",
    crontabLine("/srv/runpanel/data/autostart/start.sh") ===
      "@reboot /srv/runpanel/data/autostart/start.sh"
  );

  // --- quoting -------------------------------------------------------------
  r.check("a plain path is quoted", shellQuote("/srv/app") === "'/srv/app'");
  // The canonical POSIX escape: close the quote, emit an escaped one, reopen.
  // `\'` inside single quotes is not an escape in sh — it ends the string.
  r.check(
    "a path with a quote in it cannot break out",
    shellQuote("/srv/it's here") === `'/srv/it'\\''s here'`,
    shellQuote("/srv/it's here")
  );
  const trickyScript = renderStartScript({ ...INPUT, workingDirectory: "/srv/a'b" }, "/tmp/x.log");
  r.check(
    "a hostile directory name stays inside its quotes",
    trickyScript.includes(`cd '/srv/a'\\''b'`),
    trickyScript.split("\n").find((line) => line.startsWith("cd"))
  );

  // --- the paste-once install ---------------------------------------------
  const commands = installCommands(unit);
  r.check("three commands, in order", commands.length === 3, String(commands.length));
  r.check("the first writes the unit through sudo tee", commands[0].startsWith(`sudo tee ${UNIT_PATH}`));
  r.check(
    "it uses a quoted heredoc, so nothing in the unit is expanded",
    commands[0].includes("<<'RUNPANEL_EOF'") && commands[0].endsWith("RUNPANEL_EOF")
  );
  r.check("the unit inside the heredoc is byte-identical", commands[0].includes(unit));
  r.check("then a daemon-reload", commands[1] === "sudo systemctl daemon-reload");
  // `enable`, never `enable --now`: starting it here would put a second panel
  // on the same port next to the one that just printed these commands.
  r.check("then enable, and never start", commands[2] === "sudo systemctl enable runpanel.service");

  return r.result();
}
