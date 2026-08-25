/**
 * Last line of defence before a git error is written down.
 *
 * The header a fetch authenticates with now travels in the environment, so it
 * is no longer in the argv that `execFile` pastes into its rejection message.
 * This exists for everything that is not that: a remote URL somebody typed with
 * the credentials still in it, an older clone whose `.git/config` carries them,
 * a token echoed back by a tool the panel shells out to.
 *
 * The rule that decides where it is applied: at the points where an error is
 * *persisted or displayed*, not per log line. `appendLog` carries thousands of
 * build lines per deploy and does not need a regex on each of them.
 *
 * No imports, so the unit suite can hold it against the real strings git emits.
 */

/**
 * Ordered, and the order matters: the `Authorization` and `extraheader` rules
 * consume the base64 blob that would otherwise be left sitting on the line, and
 * the URL rule runs before the bare-token rule so that a token inside a URL is
 * reported as a redacted URL rather than as a redacted URL containing a
 * separately redacted token.
 */
const RULES: Array<[RegExp, string]> = [
  // `Authorization: basic eDphY2Nlc3M…` — the shape an extraheader takes once
  // git has pasted it into a command line.
  [/\b(authorization:\s*)(basic|bearer)\s+\S+/gi, "$1$2 <redatto>"],

  // `http.https://github.com.extraheader=Authorization: basic …` — the config
  // assignment itself, to the end of the line.
  [/\b(http\.[^\s=]*extraheader=)[^\n]*/gi, "$1<redatto>"],

  // Credentials embedded in a URL, in any scheme. The host is deliberately kept
  // — a redacted URL that no longer says where it was going is a worse error
  // message, and the host is not the secret.
  [/(:\/\/)[^/\s@]+@/g, "$1<redatto>@"],

  // GitHub's own token shapes, for the case where one reaches a message by a
  // route none of the above describes.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<redatto>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redatto>"],
];

/**
 * Remove anything that looks like a git credential from free text.
 *
 * Deliberately conservative: ordinary git output has to pass through unchanged,
 * because the deploy log is the thing an operator reads to find out why a build
 * failed and a log full of `<redatto>` is a log nobody trusts.
 */
export function redactGitSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
