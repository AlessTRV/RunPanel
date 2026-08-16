/**
 * What may be handed to `git` as an argument.
 *
 * Two values reach `execFile("git", [...])` from a browser — a commit and a
 * branch — and `execFile` does not go through a shell, so there is nothing to
 * escape and nothing that escaping would buy. What is left is git's own
 * argument parsing: a value beginning with `-` is read as an option, and
 * `--upload-pack=<cmd>` where a SHA was expected runs a command on this machine.
 * The accepted character set is therefore the entire defence, which is why it
 * lives in one place with no imports at all.
 *
 * No imports is also what makes it testable: `lib/validation.ts` pulls in
 * `./cron`, and Node's ESM loader cannot resolve an extensionless relative
 * import when a suite loads the TypeScript directly.
 */

/**
 * A commit id, in the form the GitHub API hands out.
 *
 * Full form only. `git fetch origin <sha>` against a remote wants the whole
 * object id, and an abbreviated one fails server-side with an error about the
 * protocol rather than about the length. 64 digits for the day a repository is
 * on SHA-256.
 *
 * Do NOT widen this to ref names: `refs/heads/x` is a legitimate value for git
 * and a vector for everything else.
 */
export const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const COMMIT_SHA_RULE = "Serve lo SHA completo del commit, 40 caratteri esadecimali";

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_PATTERN.test(value);
}

/**
 * The characters a branch name may be built from.
 *
 * The same set the webhook receiver already applies silently
 * (`replace(/[^a-zA-Z0-9._/-]/g, "")`), declared here rather than performed
 * behind the caller's back so the two cannot drift apart.
 */
export const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const BRANCH_NAME_RULE = "Nome del branch non valido";

/**
 * `..` is excluded separately: it is the one way out of a path built entirely
 * from legal characters, and the branch ends up both in a URL path and in a
 * refspec. The other two are git's own rules for a ref name.
 */
export function isBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (!BRANCH_NAME_PATTERN.test(value)) return false;
  return !value.includes("..") && !value.endsWith(".lock") && !value.endsWith("/");
}
