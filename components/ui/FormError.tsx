import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * What went wrong with a form, next to the button that tried.
 *
 * The sections of a settings tab each wrote their own `<p className="text-danger
 * text-xs">`, some with `role="alert"` and most without, so a screen reader
 * heard about one failure in four. For an error that belongs to one field, use
 * `Field`'s `error` instead.
 */
export function FormError({ children, className }: { children: React.ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn("text-danger flex items-start gap-1.5 text-xs", className)}>
      <Icon icon="solar:danger-circle-linear" width={14} aria-hidden className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}
