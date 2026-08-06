import { cn } from "@/lib/utils";

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
export function PageSkeleton() {
  return (
    <div className="animate-in fade-in duration-200">
      <div className="mb-6 space-y-2">
        <SkeletonText className="h-5 w-48" />
        <SkeletonText className="w-72" />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonBlock key={i} className="h-24" />
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
    </div>
  );
}
