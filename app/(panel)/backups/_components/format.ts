/**
 * Backup wording that is not a formatter.
 *
 * Dates, durations and sizes moved to `lib/format.ts`: they were being written
 * again in every screen that needed them, and the versions had drifted apart.
 * What stays here is the one thing that is genuinely local — naming a trigger is
 * domain vocabulary, not formatting, and it has no meaning outside backups.
 */

/** What a run was started by, in words. */
export function triggerLabel(trigger: string): string {
  if (trigger === "schedule") return "pianificato";
  if (trigger === "pre-restore") return "sicurezza pre-ripristino";
  return "manuale";
}
