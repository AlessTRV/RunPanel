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

