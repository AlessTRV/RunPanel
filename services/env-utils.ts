import path from "path";
import os from "os";

/**
 * Merge project env vars into process.env without clobbering PATH.
 * On Windows, env var keys are case-insensitive at OS level but JS objects
 * are case-sensitive — process.env may have "Path" while user vars have "PATH".
 * We preserve the system PATH and append any user-supplied PATH to it.
 */
export function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  if (!extra) return merged;

  // Grab the system PATH value (could be "Path", "PATH", or "path" on Windows)
  const systemPathKey = Object.keys(merged).find((k) => k.toLowerCase() === "path") || "PATH";
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
