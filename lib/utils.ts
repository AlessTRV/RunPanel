import { nanoid } from "nanoid";

export function generateId(): string {
  return nanoid(12);
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Final safety: must match safe pattern, no path traversal possible
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return `project-${Date.now()}`;
  }
  return slug;
}

/** Validate a slug is safe for filesystem paths */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes("..");
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
