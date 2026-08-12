import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { config } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { getSetting, setSetting } from "@/lib/settings";
import { HOST_CHANNEL, opsEvents } from "../events";
import {
  autostartProbeCache,
  probeAutostart,
  resolveNextBin,
  type AutostartProbe,
} from "./probe";
import {
  UNIT_NAME,
  UNIT_PATH,
  crontabLine,
  installCommands,
  renderStartScript,
  renderUnit,
  uninstallCommands,
  type UnitInput,
} from "./render";

const exec = promisify(execFile);

/**
 * Installing the boot configuration, or explaining exactly how to.
 *
 * The panel installs it itself only when it is root. Otherwise it renders the
 * commands — a heredoc that writes the same bytes it would have written — and
 * hands them over. What it never does is `systemctl start`: that would spawn a
 * second instance fighting the running one for the port. `enable` is enough,
 * and the message says so.
 */

export const HOST_SETTING = "autostart_host_config";

export interface HostConfig {
  method: "systemd" | "cron";
  installedAt: string;
  unitPath?: string;
  scriptPath?: string;
}

export function unitInput(probe: AutostartProbe): UnitInput {
  const cwd = probe.environment.workingDirectory;
  return {
    nodePath: probe.environment.nodePath,
    nextBin: resolveNextBin(cwd),
    workingDirectory: cwd,
    user: probe.environment.user,
    port: probe.environment.port,
    dataDir: config.dataDir,
    envFile: path.join(cwd, ".env"),
  };
}

export interface InstallPlan {
  method: "systemd" | "cron";
  unit?: string;
  script?: string;
  scriptPath?: string;
  crontab?: string;
  commands: string[];
  /** Whether the panel can do it itself right now. */
  canInstall: boolean;
  reason: string;
}

export async function planInstall(method?: "systemd" | "cron"): Promise<InstallPlan> {
  const probe = await probeAutostart();
  const chosen = method ?? (probe.recommended === "cron" ? "cron" : "systemd");
  const input = unitInput(probe);

  if (probe.environment.containerised) {
    return {
      method: "systemd",
      commands: probe.selfContainer.id
        ? [`docker update --restart unless-stopped ${probe.selfContainer.id}`]
        : [],
      canInstall: false,
      reason:
        "Il pannello gira dentro un container. Qui non serve una unit: basta che il container " +
        "abbia una restart policy, ed è Docker a riportarlo su.",
    };
  }

  if (probe.environment.platform !== "linux") {
    return {
      method: chosen,
      commands: [],
      canInstall: false,
      reason: `L'installazione automatica è disponibile solo su Linux (qui: ${probe.environment.platform}).`,
    };
  }

  if (chosen === "cron") {
    const scriptPath = path.join(config.dataDir, "autostart", "start.sh");
    const logFile = path.join(config.logsDir, "autostart.log");
    const script = renderStartScript(input, logFile);
    return {
      method: "cron",
      script,
      scriptPath,
      crontab: crontabLine(scriptPath),
      commands: [
        `mkdir -p ${path.dirname(scriptPath)}`,
        `cat > ${scriptPath} <<'RUNPANEL_EOF'\n${script}RUNPANEL_EOF`,
        `chmod 700 ${scriptPath}`,
        `( crontab -l 2>/dev/null | grep -v runpanel/autostart; echo '${crontabLine(scriptPath)}' ) | crontab -`,
      ],
      canInstall: true,
      reason: "Il crontab appartiene a questo utente: il pannello può scriverlo da sé.",
    };
  }

  const unit = renderUnit(input);
  return {
    method: "systemd",
    unit,
    commands: installCommands(unit),
    canInstall: probe.environment.root,
    reason: probe.environment.root
      ? "Il pannello gira da root: può installare la unit direttamente."
      : "Il pannello non gira da root. Incolla i comandi qui sotto in un terminale con sudo.",
  };
}

async function run(command: string, args: string[], input?: string): Promise<string> {
  const child = exec(command, args, { timeout: 30_000, windowsHide: true });
  if (input !== undefined) child.child.stdin?.end(input);
  const { stdout } = await child;
  return stdout.toString().trim();
}

export async function install(method?: "systemd" | "cron"): Promise<{ ok: boolean; message: string; plan: InstallPlan }> {
  const plan = await planInstall(method);
  const log = (line: string) => opsEvents.emit(HOST_CHANNEL, { type: "autostart:log", line });

  if (!plan.canInstall) {
    return { ok: false, message: plan.reason, plan };
  }

  try {
    if (plan.method === "systemd") {
      fs.writeFileSync(UNIT_PATH, plan.unit ?? "", { mode: 0o644 });
      await run("systemctl", ["daemon-reload"]);
      // `enable`, deliberately not `enable --now`: starting it here would put a
      // second panel on the same port, next to the one running this code.
      await run("systemctl", ["enable", UNIT_NAME]);
      log(`Unit installata in ${UNIT_PATH} e abilitata`);
      await remember({ method: "systemd", installedAt: new Date().toISOString(), unitPath: UNIT_PATH });
      return {
        ok: true,
        message:
          "Abilitato. RunPanel partirà al prossimo riavvio della macchina; l'istanza attuale continua a girare.",
        plan,
      };
    }

    const scriptPath = plan.scriptPath ?? path.join(config.dataDir, "autostart", "start.sh");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, plan.script ?? "", { mode: 0o700 });

    const existing = await currentCrontab();
    const kept = existing
      .split("\n")
      .filter((line) => line.trim() && !line.includes(scriptPath))
      .join("\n");
    await run("crontab", ["-"], `${kept ? `${kept}\n` : ""}${crontabLine(scriptPath)}\n`);

    log(`Riga @reboot aggiunta al crontab, script in ${scriptPath}`);
    await remember({ method: "cron", installedAt: new Date().toISOString(), scriptPath });
    return {
      ok: true,
      message: "Riga @reboot installata. RunPanel partirà al prossimo riavvio della macchina.",
      plan,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Installazione non riuscita: ${message}`, plan };
  }
}

export async function uninstall(): Promise<{ ok: boolean; message: string }> {
  const stored = await storedConfig();
  const probe = await probeAutostart();

  try {
    if (stored?.method === "cron" || (!stored && probe.cron.installed)) {
      const scriptPath = stored?.scriptPath ?? path.join(config.dataDir, "autostart", "start.sh");
      const existing = await currentCrontab();
      const kept = existing
        .split("\n")
        .filter((line) => line.trim() && !line.includes(scriptPath) && !/runpanel/i.test(line))
        .join("\n");
      await run("crontab", ["-"], kept ? `${kept}\n` : "\n");
      fs.rmSync(scriptPath, { force: true });
      await remember(null);
      return { ok: true, message: "Riga @reboot rimossa." };
    }

    if (!probe.environment.root) {
      return {
        ok: false,
        message: `Serve root. Esegui:\n${uninstallCommands().join("\n")}`,
      };
    }

    await run("systemctl", ["disable", UNIT_NAME]);
    fs.rmSync(UNIT_PATH, { force: true });
    await run("systemctl", ["daemon-reload"]);
    await remember(null);
    return { ok: true, message: "Unit disabilitata e rimossa." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Rimozione non riuscita: ${message}` };
  }
}

async function currentCrontab(): Promise<string> {
  try {
    return await run("crontab", ["-l"]);
  } catch {
    // No crontab for this user yet, which is the ordinary starting state.
    return "";
  }
}

/**
 * Record what this host now does about booting the panel.
 *
 * Also drops the cached probe: it reads exactly what this call just changed,
 * and an operator who presses Install wants the page to say so at once rather
 * than in half a minute.
 */
async function remember(config: HostConfig | null): Promise<void> {
  await setSetting(HOST_SETTING, JSON.stringify(config));
  autostartProbeCache.invalidate();
}

export async function storedConfig(): Promise<HostConfig | null> {
  const raw = await getSetting(HOST_SETTING);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostConfig | null;
  } catch {
    return null;
  }
}

/** One-click repairs the diagnostics offer. */
export async function applyFix(
  fix: "docker-enable" | "pm2-save"
): Promise<{ ok: boolean; message: string }> {
  try {
    if (fix === "docker-enable") {
      const env = getEnv();
      if (env.disableSchedulers) {
        return { ok: false, message: "Operazione disattivata in questa istanza" };
      }
      await run("systemctl", ["enable", "docker"]);
      return { ok: true, message: "Docker verrà avviato al boot." };
    }

    // Idempotent and safe: it writes down the process list PM2 already has, so
    // `pm2 resurrect` brings back what is running rather than what used to be.
    await run("pm2", ["save"]);
    return {
      ok: true,
      message: `Lista PM2 salvata in ${path.join(os.homedir(), ".pm2", "dump.pm2")}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
