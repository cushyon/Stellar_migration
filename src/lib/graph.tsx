import type { ReactNode } from "react";

// UIVaultCushion chart palette (its globals.css):
//   --positive-green / --negative-red = hsl(55 89% 51%)  → a single gold, used
//     for the line regardless of sign (no red/green split).
//   --chart-area-neutral               = hsl(0 0% 0%)     → the area fill.
export const LINE_COLOR = "hsl(55, 89%, 51%)";
export const AREA_COLOR = "hsl(0, 0%, 0%)";

/** Vertical gradient stops of a single color with start/end opacity. */
export function gradientStops(color: string, startOpacity = 1, endOpacity = 1): ReactNode {
  return (
    <>
      <stop offset="0%" stopColor={color} stopOpacity={startOpacity} />
      <stop offset="100%" stopColor={color} stopOpacity={endOpacity} />
    </>
  );
}

/** Pad the y-domain so a positive-only curve looks less steep (never below 0). */
export function getYDomain(minY: number, maxY: number): [number, number] | [number, "auto"] {
  // Flat (or single-point) series: pad a band around the value so the line
  // sits centered instead of glued to an edge with a broken auto-scale.
  if (maxY - minY < Math.abs(maxY) * 1e-6) {
    const pad = Math.abs(maxY) * 0.05 || 1;
    return [minY - pad, maxY + pad];
  }
  if (minY >= 0) {
    const offset = (maxY - minY) * 2;
    return [Math.max(minY - offset, 0), "auto"];
  }
  return [minY, "auto"];
}
