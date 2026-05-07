export function Background() {
  return (
    <div
      className="fixed inset-0 z-[-1] pointer-events-none overflow-hidden"
      style={{ background: "linear-gradient(to bottom, var(--page-bg-from), var(--page-bg-to))" }}
    >
      {/* Blob glows */}
      <div
        className="absolute -top-[15%] -left-[5%] w-[55%] h-[55%] rounded-full blur-[160px]"
        style={{ backgroundColor: "rgb(var(--blob-purple) / var(--blob-opacity-1))" }}
      />
      <div
        className="absolute -bottom-[15%] -right-[5%] w-[60%] h-[55%] rounded-full blur-[160px]"
        style={{ backgroundColor: "rgb(var(--blob-purple) / var(--blob-opacity-2))" }}
      />
      <div
        className="absolute top-[5%] left-1/2 -translate-x-1/2 w-[65%] h-[45%] rounded-[100%] blur-[130px]"
        style={{ backgroundColor: "rgb(var(--blob-purple) / var(--blob-opacity-3))" }}
      />
      <div
        className="absolute top-[35%] left-[30%] w-[40%] h-[35%] rounded-full blur-[120px]"
        style={{ backgroundColor: "rgb(var(--blob-violet) / var(--blob-opacity-4))" }}
      />

      {/* Vignette */}
      <div
        className="absolute inset-0 opacity-80"
        style={{ background: "radial-gradient(ellipse at center, transparent 20%, var(--vignette-color) 80%)" }}
      />

      {/* Film grain */}
      <svg
        className="absolute inset-0 w-full h-full"
        style={{ opacity: "var(--grain-opacity)", mixBlendMode: "soft-light" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </div>
  );
}
