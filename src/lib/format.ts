/** Format a base-unit i128 (as string) into a human amount with `decimals` dp. */
export function fromBaseUnits(value: string | bigint, decimals: number): number {
  const v = BigInt(value);
  return Number(v) / 10 ** decimals;
}

/** Compact token amount, e.g. 1_234_500_0000000 → "123.45". */
export function formatAmount(value: string | bigint, decimals: number, dp = 2): string {
  const n = fromBaseUnits(value, decimals);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(dp);
}

/** A fractional return (e.g. 0.0514) → "+5.14%" / "-2.10%" / "-" when null. */
export function formatPct(ret: number | null | undefined): string {
  if (ret == null) return "-";
  const pct = ret * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
