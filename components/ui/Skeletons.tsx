import { cn } from "@/lib/utils";
import { PageHeader } from "./PageHeader";

/**
 * Shape-matched placeholders. A skeleton that matches the real layout keeps the
 * page from jumping when data lands — a centred spinner, which is what every
 * route used before, guarantees it will.
 */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("bg-default animate-pulse rounded-[var(--radius)]", className)} />;
}

export function SkeletonText({ className }: { className?: string }) {
  return <div className={cn("bg-default h-3 animate-pulse rounded-full", className)} />;
}

/** Placeholder for a page built from a header, a stat row and a list. */
/**
 * The page before its data.
 *
 * With `title`, the real header is drawn instead of a grey bar: it is known
 * before the fetch, and keeping it in place means the page does not jump when
 * the content arrives. `tiles` matches the stat row the page really has —
 * four grey tiles above a page with three read as a layout that changed.
 */
export function PageSkeleton({
  title,
  description,
  tiles = 4,
}: {
  title?: string;
  description?: string;
  tiles?: number;
} = {}) {
  return (
    <div className="animate-in fade-in duration-200">
      {title ? (
        <PageHeader title={title} description={description} />
      ) : (
        <div className="mb-6 space-y-2">
          <SkeletonText className="h-5 w-48" />
          <SkeletonText className="w-72" />
        </div>
      )}

      {tiles > 0 && (
        <div className={cn("mb-6 grid grid-cols-2 gap-3", tiles === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4")}>
          {Array.from({ length: tiles }, (_, i) => (
            <SkeletonBlock key={i} className="h-20" />
          ))}
        </div>
      )}

      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
    </div>
  );
}
