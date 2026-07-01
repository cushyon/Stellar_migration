import type { ReactNode } from "react";

// Matches the vault graph palette (green above the 0 line, red below).
export const POSITIVE_GREEN = "#4ade80";
export const NEGATIVE_RED = "#f87171";

/**
 * Gradient stops for the area/line: green above the x-axis (0), red below.
 * The color switches at the offset where the curve crosses zero.
 */
export function getAreaStops(
  min: number,
  max: number,
  { startOpacity = 1, endOpacity = 1 }: { startOpacity?: number; endOpacity?: number } = {}
): ReactNode {
  if (min >= 0) {
    return (
      <>
        <stop offset="0%" stopColor={POSITIVE_GREEN} stopOpacity={startOpacity} />
        <stop offset="100%" stopColor={POSITIVE_GREEN} stopOpacity={endOpacity} />
      </>
    );
  }
  if (max <= 0) {
    return (
      <>
        <stop offset="0%" stopColor={NEGATIVE_RED} stopOpacity={endOpacity} />
        <stop offset="100%" stopColor={NEGATIVE_RED} stopOpacity={startOpacity} />
      </>
    );
  }
  const zeroOffset = (max / (max - min)) * 100;
  return (
    <>
      <stop offset="0%" stopColor={POSITIVE_GREEN} stopOpacity={1} />
      <stop offset={`${zeroOffset}%`} stopColor={POSITIVE_GREEN} stopOpacity={endOpacity} />
      <stop offset={`${zeroOffset}%`} stopColor={NEGATIVE_RED} stopOpacity={endOpacity} />
      <stop offset="100%" stopColor={NEGATIVE_RED} stopOpacity={1} />
    </>
  );
}

/** Pad the y-domain so a positive-only curve looks less steep (never below 0). */
export function getYDomain(minY: number, maxY: number): [number, "auto"] {
  if (minY >= 0) {
    const offset = (maxY - minY) * 2;
    return [Math.max(minY - offset, 0), "auto"];
  }
  return [minY, "auto"];
}
