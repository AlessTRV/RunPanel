/**
 * The page backdrop.
 *
 * The previous version stacked four 120–160px blurred blobs, a radial vignette
 * and a full-viewport SVG `feTurbulence` grain in `mix-blend-mode: soft-light`,
 * underneath a dozen `backdrop-blur` surfaces. That is a permanent compositing
 * cost on every scroll and every re-render, and it was the single most expensive
 * visual choice in the app.
 *
 * This does the same job — stop the page reading as a flat slab — with two
 * static gradients and a 1px grid. No filters, no blend modes, nothing that
 * forces a repaint. It is a plain server component with no client JS.
 */
export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[-1] overflow-hidden">
      {/* Very slight lift towards the top, so the sidebar and topbar have
          something to sit against without a visible seam. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 50% -20%, oklch(100% 0 0 / 4%) 0%, transparent 60%)",
        }}
      />
      {/* Grid, fading out before it reaches the edges so it never draws
          attention to itself. */}
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(to right, oklch(100% 0 0 / 2.5%) 1px, transparent 1px)," +
            "linear-gradient(to bottom, oklch(100% 0 0 / 2.5%) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(100% 70% at 50% 0%, black 0%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(100% 70% at 50% 0%, black 0%, transparent 75%)",
        }}
      />
    </div>
  );
}
