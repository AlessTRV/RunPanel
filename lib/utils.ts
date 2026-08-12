import { nanoid } from "nanoid";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, letting a later conflicting Tailwind utility win.
 * Without twMerge, `cn("p-4", "p-2")` would emit both and the winner would
 * depend on stylesheet order rather than call order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

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

/**
 * Bytes as people read them. Binary units, because that is what `docker system
 * df` and every filesystem tool on the host report, and a panel that disagreed
 * with them by 7% would look wrong rather than precise.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
