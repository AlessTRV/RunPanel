import path from "path";
import os from "os";
import { sanitizedProcessEnv } from "@/lib/env";
import { toolchainPath } from "./toolchain";

export { toolchainPath, whichSync } from "./toolchain";

/**
 * Build the environment for a child process: a user's build command, or an app
 * started under PM2.
 *
 * The base is `process.env` with RunPanel's own configuration stripped out —
 * see `PRIVATE_ENV_KEYS`. Without that, every build script a user deploys would
 * inherit `RUNPANEL_SECRET`, the key that every stored env var in the panel is
 * encrypted with.
 *
 * PATH is then repaired via `toolchainPath()`, unconditionally and before any
 * caller-supplied value is merged in — see there for why the inherited one
 * cannot be trusted.
 *
 * On Windows, env var keys are case-insensitive at OS level but JS objects
 * are case-sensitive — process.env may have "Path" while user vars have "PATH".
 * We preserve the system PATH and append any user-supplied PATH to it.
 */
export function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = sanitizedProcessEnv();

  // Grab the system PATH value (could be "Path", "PATH", or "path" on Windows)
  const systemPathKey = Object.keys(merged).find((k) => k.toLowerCase() === "path") || "PATH";
  merged[systemPathKey] = toolchainPath(merged[systemPathKey] || "");

  if (!extra) return merged;

  const systemPath = merged[systemPathKey] || "";

  for (const [key, value] of Object.entries(extra)) {
    if (key.toLowerCase() === "path") {
      // Append user PATH to system PATH instead of replacing
      merged[systemPathKey] = value ? `${systemPath}${path.delimiter}${value}` : systemPath;
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Get the absolute path to the system shell.
 * On Windows: C:\WINDOWS\system32\cmd.exe (resolved via SystemRoot)
 * On Linux/Mac: /bin/bash (needed for `source`, venv activation, etc.)
 */
export function getShellPath(): string {
  if (os.platform() === "win32") {
    return path.join(
      process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\WINDOWS",
      "system32",
      "cmd.exe"
    );
  }
  return "/bin/bash";
}

/** Whether the current platform is Windows */
export const isWindows = os.platform() === "win32";
