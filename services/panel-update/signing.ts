import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getSetting } from "@/lib/settings";
import {
  PANEL_UPDATE_ALLOWED_SIGNERS_SETTING,
  PANEL_UPDATE_REQUIRE_SIGNATURE_SETTING,
} from "@/lib/panel-update";

/**
 * Turning "the operator wants signed updates" into git configuration.
 *
 * Its own file rather than part of `run.ts` because it is the only piece of the
 * update that touches settings and the filesystem for a reason unrelated to
 * updating, and because `policy.ts` — where the *decisions* live — may not
 * import anything.
 */

/** Whether the operator has asked for the incoming commit to be verified. */
export async function signatureRequired(): Promise<boolean> {
  try {
    return (await getSetting(PANEL_UPDATE_REQUIRE_SIGNATURE_SETTING)) === "1";
  } catch {
    // A settings read that fails must not silently disable a security control
    // the operator switched on, but it must not brick the panel either. The
    // caller treats a thrown error as "cannot verify", which fails closed.
    throw new Error("Impossibile leggere le impostazioni di verifica della firma.");
  }
}

/**
 * The allowed-signers file on disk, written from the setting.
 *
 * Rewritten on every run rather than cached: the operator edits this in the UI
 * and the next update has to use what they typed, not what was there when the
 * panel booted. Returns null when the setting is empty, which is the GPG case —
 * there the trust root is the user's keyring and there is nothing to write.
 */
export async function materializeAllowedSigners(): Promise<string | null> {
  let content: string;
  try {
    content = (await getSetting(PANEL_UPDATE_ALLOWED_SIGNERS_SETTING)) ?? "";
  } catch {
    return null;
  }
  if (!content.trim()) return null;

  const file = path.join(config.dataDir, "panel-update-allowed-signers");
  fs.writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
  // writeFileSync only applies the mode when creating, and this is rewritten on
  // every update — a wider mode set once would otherwise survive forever.
  try {
    fs.chmodSync(file, 0o600);
  } catch { /* Windows and some network filesystems have no mode bits to set. */ }

  return file;
}

/**
 * The extra git config a verification needs, as key/value pairs.
 *
 * Empty for GPG: git already knows how to check those against the keyring of
 * the user the panel runs as, and forcing `gpg.format` there would break it.
 */
export async function signingConfig(): Promise<Array<[string, string]>> {
  const signers = await materializeAllowedSigners();
  if (!signers) return [];
  return [
    ["gpg.format", "ssh"],
    ["gpg.ssh.allowedSignersFile", signers],
  ];
}
