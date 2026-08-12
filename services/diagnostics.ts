import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { isValidTimeZone } from "@/lib/cron";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { staleWhileRevalidate } from "@/lib/stale-cache";
import { formatBytes } from "@/lib/utils";
import { dockerTry } from "./docker/cli";
import { autostartProbeCache } from "./autostart/probe";

const exec = promisify(execFile);

/**
 * One place that knows whether this installation is healthy.
 *
 * Deliberately the *only* place. The dashboard, the onboarding checklist and
 * the diagnostics page all render this same list — a second opinion computed
 * somewhere else is how a panel ends up telling you two different things about
 * the same machine.
 */

export type CheckTone = "ok" | "warn" | "danger" | "neutral";

export interface Check {
  id: string;
  title: string;
  tone: CheckTone;
  detail: string;
  /** A one-click repair, when there is one that is safe to offer. */
  fix?: { label: string; endpoint: string; body?: Record<string, unknown> };
  /** Where to go and sort it out by hand. */
  href?: string;
}

async function binary(name: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await exec(name, args, { timeout: 5_000, windowsHide: true });
    return stdout.toString().trim().split("\n")[0];
  } catch {
    return null;
  }
}

function freeSpace(dir: string): { free: number; total: number } | null {
  try {
    const stat = fs.statfsSync(dir);
    return {
      free: Number(stat.bsize) * Number(stat.bavail),
      total: Number(stat.bsize) * Number(stat.blocks),
    };
  } catch {
    return null;
  }
}

function writable(dir: string): boolean {
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cached view of `runDiagnostics`, for the endpoint that gets polled.
 *
 * A single answer costs roughly ten child processes plus a synchronous write
 * probe, and the diagnostics page asks every 30s while the dashboard's health
 * banner asks every 60s. Sharing one reading between them, and reusing it for
 * the TTL, is the difference between a background load and none.
 */
export const diagnosticsCache = staleWhileRevalidate(() => runDiagnostics(), 30_000);

export async function runDiagnostics(): Promise<Check[]> {
  const env = getEnv();
  const checks: Check[] = [];

  // --- Docker ---------------------------------------------------------------
  const dockerVersion = await dockerTry(["version", "--format", "{{.Server.Version}}"], {
    timeout: 5_000,
  });
  checks.push(
    dockerVersion
      ? {
          id: "docker",
          title: "Docker",
          tone: "ok",
          detail: `Server ${dockerVersion.stdout.trim()} raggiungibile`,
        }
      : {
          id: "docker",
          title: "Docker",
          tone: "danger",
          detail:
            "Il daemon non risponde. Senza Docker non si provisionano database, non si deploya " +
            "in container e non si fanno backup dei database.",
        }
  );

  // --- Binaries -------------------------------------------------------------
  // pm2 is the one that matters most and is the one most likely to be missing:
  // it runs every project with a native runtime, and its absence shows up as a
  // deploy that fails for no visible reason.
  const [git, pm2, tar] = await Promise.all([
    binary("git"),
    binary("pm2", ["-v"]),
    binary("tar"),
  ]);

  checks.push({
    id: "pm2",
    title: "PM2",
    tone: pm2 ? "ok" : "warn",
    detail: pm2
      ? `Disponibile (${pm2})`
      : "Non trovato nel PATH. I progetti con runtime nativo (node, static, custom) non possono partire.",
    href: pm2 ? undefined : "/autostart",
  });

  checks.push({
    id: "git",
    title: "Git",
    tone: git ? "ok" : "warn",
    detail: git ? git : "Non trovato: i deploy da GitHub non funzionano.",
  });

  checks.push({
    id: "tar",
    title: "tar",
    tone: tar ? "ok" : "neutral",
    detail: tar ? tar : "Non trovato sull'host: serve solo per estrarre gli upload ZIP.",
  });

  // --- Storage ---------------------------------------------------------------
  const space = freeSpace(config.dataDir);
  if (space) {
    const ratio = space.total > 0 ? space.free / space.total : 1;
    checks.push({
      id: "disk",
      title: "Spazio su disco",
      tone: space.free < 2 * 1024 ** 3 ? "danger" : ratio < 0.1 ? "warn" : "ok",
      detail: `${formatBytes(space.free)} liberi su ${formatBytes(space.total)}. I backup si rifiutano di partire sotto i 2 GB.`,
      href: "/storage",
    });
  }

  checks.push({
    id: "data-dir",
    title: "Cartella dati",
    tone: writable(config.dataDir) ? "ok" : "danger",
    detail: writable(config.dataDir)
      ? `Scrivibile: ${config.dataDir}`
      : `Non scrivibile: ${config.dataDir}`,
  });

  checks.push({
    id: "backups-dir",
    title: "Cartella backup",
    tone: writable(config.backupArchivesDir) ? "ok" : "danger",
    detail: writable(config.backupArchivesDir)
      ? `Scrivibile: ${config.backupArchivesDir}`
      : `Non scrivibile: ${config.backupArchivesDir}`,
    href: "/backups",
  });

  // --- Secret ---------------------------------------------------------------
  const fromEnv = Boolean(env.secret);
  let mode: string | null = null;
  try {
    // Windows has no POSIX mode bits: NTFS reports 0666 whatever was asked for,
    // so checking it there would show a permanent warning nobody can act on.
    if (process.platform !== "win32") {
      mode = (fs.statSync(config.secretFile).mode & 0o777).toString(8);
    }
  } catch {
    /* no file, which is the case when the key comes from the environment */
  }
  checks.push({
    id: "secret",
    title: "Chiave di cifratura",
    tone: fromEnv || mode === "600" || mode === null ? "ok" : "warn",
    detail: fromEnv
      ? "Fornita da RUNPANEL_SECRET. Tienila nei tuoi backup: senza, le variabili cifrate non si leggono più."
      : mode
        ? `In ${config.secretFile}, permessi 0${mode}${mode === "600" ? "" : " — dovrebbero essere 0600"}`
        : `In ${config.secretFile}. Tienila nei tuoi backup: senza, le variabili cifrate non si leggono più.`,
  });

  // --- Store ----------------------------------------------------------------
  try {
    const db = await getDb();
    const applied = await db
      .selectFrom("kysely_migration" as never)
      .select("name" as never)
      .execute()
      .catch(() => []);
    checks.push({
      id: "store",
      title: "Store",
      tone: "ok",
      detail: `${env.db.driver}, ${(applied as unknown[]).length} migrazioni applicate`,
    });
  } catch (err) {
    checks.push({
      id: "store",
      title: "Store",
      tone: "danger",
      detail: err instanceof Error ? err.message : "Non raggiungibile",
    });
  }

  // --- Time zone -------------------------------------------------------------
  const timezone = (await getSetting("timezone")) ?? "UTC";
  checks.push({
    id: "timezone",
    title: "Fuso orario",
    tone: isValidTimeZone(timezone) ? "ok" : "warn",
    detail: isValidTimeZone(timezone)
      ? `${timezone} — è il fuso con cui vengono interpretate le pianificazioni`
      : `"${timezone}" non è un fuso valido: le pianificazioni useranno UTC`,
    href: "/account",
  });

  // --- Pending restore -------------------------------------------------------
  if (fs.existsSync(path.join(config.dataDir, ".restore-pending"))) {
    checks.push({
      id: "restore-pending",
      title: "Ripristino in attesa",
      tone: "warn",
      detail:
        "Uno store ripristinato è pronto e verrà messo in servizio al prossimo riavvio del pannello.",
      href: "/backups",
    });
  }

  // --- Boot ------------------------------------------------------------------
  const probe = await autostartProbeCache.get();
  const bootConfigured =
    probe.environment.containerised ||
    probe.systemd.enabled ||
    probe.cron.installed;

  checks.push({
    id: "autostart",
    title: "Avvio al boot",
    tone: bootConfigured ? "ok" : "warn",
    detail: bootConfigured
      ? probe.environment.containerised
        ? "Il pannello è in un container: ci pensa Docker"
        : `Configurato via ${probe.systemd.enabled ? "systemd" : "cron"}`
      : "Dopo un riavvio della macchina RunPanel non ripartirebbe da solo.",
    href: "/autostart",
  });

  if (probe.docker.enabledAtBoot === false) {
    checks.push({
      id: "docker-boot",
      title: "Docker al boot",
      tone: "warn",
      detail:
        "Docker non è abilitato all'avvio. Anche con il pannello configurato, i container non tornerebbero su.",
      fix: { label: "Abilita", endpoint: "/api/autostart/fix", body: { fix: "docker-enable" } },
      href: "/autostart",
    });
  }

  if (probe.pm2.available && !probe.pm2.dumpSaved) {
    checks.push({
      id: "pm2-save",
      title: "PM2 resurrect",
      tone: "warn",
      detail:
        "PM2 non ha una lista salvata: dopo un riavvio non riporterebbe su nessuna app, anche se il pannello torna.",
      fix: { label: "pm2 save", endpoint: "/api/autostart/fix", body: { fix: "pm2-save" } },
      href: "/autostart",
    });
  }

  // --- Backups ----------------------------------------------------------------
  const db = await getDb();
  const [policies, lastRun] = await Promise.all([
    db.selectFrom("backup_policies").select("id").where("enabled", "=", 1).execute(),
    db
      .selectFrom("backup_runs")
      .select(["status", "started_at"])
      .orderBy("started_at", "desc")
      .executeTakeFirst(),
  ]);

  if (policies.length === 0) {
    checks.push({
      id: "backup-policy",
      title: "Backup pianificati",
      tone: "warn",
      detail: "Nessuna pianificazione attiva: nulla viene salvato automaticamente.",
      href: "/backups",
    });
  } else if (!lastRun) {
    checks.push({
      id: "backup-run",
      title: "Backup",
      tone: "neutral",
      detail: `${policies.length} pianificazion${policies.length === 1 ? "e" : "i"} attive, nessuna ancora eseguita.`,
      href: "/backups",
    });
  } else {
    const ageMs = Date.now() - Date.parse(lastRun.started_at);
    const days = Math.floor(ageMs / 86_400_000);
    checks.push({
      id: "backup-run",
      title: "Ultimo backup",
      tone: lastRun.status === "failed" ? "danger" : days > 7 ? "warn" : "ok",
      detail:
        lastRun.status === "failed"
          ? "L'ultimo backup è fallito."
          : days === 0
            ? "Eseguito oggi."
            : `Eseguito ${days} giorn${days === 1 ? "o" : "i"} fa.`,
      href: "/backups",
    });
  }

  return checks;
}

export function worstTone(checks: Check[]): CheckTone {
  if (checks.some((check) => check.tone === "danger")) return "danger";
  if (checks.some((check) => check.tone === "warn")) return "warn";
  return "ok";
}
