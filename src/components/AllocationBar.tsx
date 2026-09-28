"use client";

import type { VaultStats, VaultRisk } from "@/services/indexer";
import { formatAmount } from "@/lib/format";

/**
 * How the vault is invested right now, from indexed onchain balances, and
 * where its value stands against the protection floor. The bar shows the safe
 * share of the vault; the floor is a value the share may not fall under, so it
 * is drawn on its own scale below, from the epoch start value.
 */
export function AllocationBar({
  stats,
  risk,
  symbol,
  safeSymbol,
  decimals,
  floorBps,
}: {
  stats: VaultStats | null;
  risk: VaultRisk | null;
  symbol: string;
  safeSymbol: string;
  decimals: number;
  floorBps: number;
}) {
  if (!stats) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-lg font-semibold">Allocation</h3>
        <p className="text-sm text-gray-400 mt-2">No indexed snapshot yet.</p>
      </div>
    );
  }

  const safePct = stats.allocation.safePct * 100;
  const strategyPct = stats.allocation.strategyPct * 100;
  // Amounts are in the base asset, whatever the role of each side.
  const safeAmount = stats.allocation.safeIsBase ? stats.allocation.base : stats.allocation.risky;
  const strategyAmount = stats.allocation.safeIsBase ? stats.allocation.risky : stats.allocation.base;

  // Value floor: the contract keeps the share value above this fraction of the
  // epoch start value. Before the first risk snapshot, show the configured floor.
  const floorPct = (risk ? risk.floorPct : floorBps / 10_000) * 100;
  const valuePct = risk?.valuePct != null ? risk.valuePct * 100 : null;
  const stopped = risk?.stopped ?? false;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">Allocation</h3>
        <span className="text-xs text-gray-500">indexed onchain balances</span>
      </div>

      {stopped && (
        <p className="mt-1 text-xs text-red-400">
          The value reached the floor. The strategy has stopped and only moves into {safeSymbol}.
        </p>
      )}

      <div className="relative mt-4 h-6 w-full overflow-hidden rounded bg-neutral-800">
        <div
          className={`h-full ${stopped ? "bg-red-500/70" : "bg-[#475569]"}`}
          style={{ width: `${Math.min(Math.max(safePct, 0), 100)}%` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Safe ({safeSymbol})</span>
          <span>
            {safePct.toFixed(1)}% · {formatAmount(safeAmount, decimals)} {symbol}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Strategy ({symbol})</span>
          <span>
            {strategyPct.toFixed(1)}% · {formatAmount(strategyAmount, decimals)} {symbol}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Protection floor</span>
          <span className="text-[hsl(55_89%_51%)]">
            {floorPct.toFixed(0)}% of start value
            {valuePct != null && (
              <span className="text-gray-400"> · now {valuePct.toFixed(1)}%</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
