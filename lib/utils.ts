import { nanoid } from "nanoid";

export function generateId(): string {
  return nanoid(12);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
