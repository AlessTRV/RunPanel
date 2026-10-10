/**
 * What a project row may show to someone below `manage`.
 *
 * The webhook secret signs pushes the public webhook route accepts: anyone who
 * reads it can start a deploy without being allowed to. Build-time variables
 * routinely carry registry and package tokens. Both are blanked rather than
 * dropped, so the shape the pages read stays the same.
 */
export function redactProject<T extends { webhook_secret: string; builder_config: string }>(row: T, canManage: boolean): T {
  if (canManage) return row;
  let builderConfig = row.builder_config;
  try {
    const parsed = JSON.parse(row.builder_config) as { buildEnv?: Record<string, string> };
    if (parsed && typeof parsed === "object" && parsed.buildEnv && typeof parsed.buildEnv === "object") {
      parsed.buildEnv = Object.fromEntries(Object.keys(parsed.buildEnv).map((key) => [key, "••••••••"]));
      builderConfig = JSON.stringify(parsed);
    }
  } catch {
    builderConfig = "{}";
  }
  return { ...row, webhook_secret: "", builder_config: builderConfig };
}
