import type { ReactNode } from "react";

// UIVaultCushion chart palette (its globals.css .dark):
//   --positive-green / --negative-red = hsl(55 89% 51%)  → gold line.
//   --chart-area-neutral               = hsl(0 0% 0%)     → area fill.
export const LINE_COLOR = "hsl(55, 89%, 51%)";
export const AREA_COLOR = "hsl(0, 0%, 0%)";
// Chart card surface (tailwind neutral-900) - dot ring + label halo.
export const SURFACE_COLOR = "hsl(0, 0%, 9%)";

/**
 * `label` renderer for the current-value ReferenceDot. The dot sits on the
 * plot's right edge, so the text is drawn to its left (a right-side label
 * would clip), with a surface-colored halo to stay legible over grid lines.
 * recharts passes the dot's bounding box as `viewBox` ({x: cx-r, y: cy-r,
 * width: 2r, height: 2r}).
 */
export function currentValueLabel(text: string) {
  return function CurrentValueLabel(props: {
    viewBox?: { x?: number; y?: number; width?: number; height?: number };
  }) {
    const box = props.viewBox ?? {};
    const cx = (box.x ?? 0) + (box.width ?? 0) / 2;
    const cy = (box.y ?? 0) + (box.height ?? 0) / 2;
    return (
      <text
        x={cx - 10}
        y={cy + 4}
        textAnchor="end"
        fontSize={12}
        fontWeight={600}
        fill={LINE_COLOR}
        stroke={SURFACE_COLOR}
        strokeWidth={4}
        paintOrder="stroke"
      >
        {text}
      </text>
    );
  };
}

/** Vertical gradient stops of a single color with start/end opacity (area fill). */
export function gradientStops(color: string, startOpacity = 1, endOpacity = 1): ReactNode {
  return (
    <>
      <stop offset="0%" stopColor={color} stopOpacity={startOpacity} />
      <stop offset="100%" stopColor={color} stopOpacity={endOpacity} />
    </>
  );
}

/**
 * Smallest/closest "nice" number near `x` - 1, 2, 5 × 10ⁿ.
 * Heckbert, "Nice Numbers for Graph Labels", Graphics Gems (1990).
 */
function niceNum(x: number, round: boolean): number {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const frac = x / 10 ** exp;
  let nice: number;
  if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

/**
 * Round domain + evenly-spaced round ticks for a numeric axis (loose labeling).
 * Pass both `domain` and `ticks` to a recharts axis - forcing a raw [min,max]
 * domain makes recharts emit ugly equal-split labels.
 */
export function niceScale(
  min: number,
  max: number,
  maxTicks = 7
): { domain: [number, number]; ticks: number[] } {
  if (max - min < 1e-9) {
    // flat / single-point series → pad a band so the line sits centered
    const d = Math.abs(max) * 0.05 || 1;
    min -= d;
    max += d;
  }
  const step = niceNum((max - min) / (maxTicks - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const n = Math.round((niceMax - niceMin) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(Number((niceMin + i * step).toFixed(6)));
  return { domain: [niceMin, niceMax], ticks };
}
