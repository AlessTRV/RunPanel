import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <p className="text-muted font-mono text-xs">404</p>
      <h1 className="text-foreground mt-2 text-lg font-medium">Pagina non trovata</h1>
      <p className="text-muted mt-1 text-sm">
        La risorsa richiesta non esiste o è stata rimossa.
      </p>
      <Link
        href="/home"
        className="border-border bg-surface text-foreground hover:bg-surface-hover mt-5 rounded-[var(--radius)] border px-4 py-2 text-sm transition-colors"
      >
        Torna alla Overview
      </Link>
    </div>
  );
}
