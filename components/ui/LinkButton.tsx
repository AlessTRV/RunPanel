import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A link that looks like a button.
 *
 * HeroUI's Button has no polymorphic `as`, so every "go there" action in this
 * codebase was a hand-styled `<Link>` carrying the same seven Tailwind classes.
 * That is how a surface ends up with four slightly different button shapes, and
 * this file exists for the same reason `Panel` does.
 *
 * `download` switches to a plain anchor: Next's Link would intercept the click
 * and try to navigate to it, which is not what you want from an endpoint that
 * answers with a zip.
 */

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-foreground hover:opacity-90 border-transparent",
  secondary: "border-border bg-surface hover:bg-surface-hover text-foreground",
  ghost: "border-transparent text-muted hover:bg-surface-hover hover:text-foreground",
};

interface Props {
  href: string;
  variant?: Variant;
  size?: "sm" | "md";
  download?: boolean;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}

export function LinkButton({
  href,
  variant = "secondary",
  size = "sm",
  download = false,
  className,
  children,
  ...rest
}: Props) {
  const classes = cn(
    "inline-flex items-center gap-1.5 rounded-[var(--radius)] border transition-colors",
    size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2 text-sm",
    VARIANTS[variant],
    className
  );

  if (download) {
    return (
      <a href={href} className={classes} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={classes} {...rest}>
      {children}
    </Link>
  );
}
