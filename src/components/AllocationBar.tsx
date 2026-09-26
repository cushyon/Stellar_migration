"use client";

import type { VaultStats, VaultRisk } from "@/services/indexer";
import { formatAmount } from "@/lib/format";

/**
 * How the vault is invested right now, straight from indexed onchain balances,
 * with the protection floor drawn on the same scale. The floor is the share of
 * the safe asset that the contract refuses to go under.
 */
export function AllocationBar({
  stats,
  risk,
  symbol,
  decimals,
  floorBps,
}: {
  stats: VaultStats | null;
  risk: VaultRisk | null;
  symbol: string;
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

  const basePct = stats.allocation.basePct * 100;
  const riskyPct = stats.allocation.riskyPct * 100;
  // The contract enforces the floor; the risk snapshot repeats it, so prefer it.
  const floorPct = (risk ? risk.floorPct : floorBps / 10_000) * 100;
  // Below the floor the vault cannot take more risk: the contract refuses it.
  const belowFloor = basePct + 0.05 < floorPct;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">Allocation</h3>
        <span className="text-xs text-gray-500">indexed onchain balances</span>
      </div>

      <div className="mt-1">
        {belowFloor && (
          <span className="text-xs text-red-400">
            The safe asset is under the floor. The vault refuses any trade that adds risk.
          </span>
        )}
      </div>

      <div className="relative mt-4 h-6 w-full overflow-hidden rounded bg-neutral-800">
        <div
          className={`h-full ${belowFloor ? "bg-red-500/70" : "bg-[#475569]"}`}
          style={{ width: `${Math.min(Math.max(basePct, 0), 100)}%` }}
        />
        {/* The floor, on the same scale as the safe share. */}
        <div
          className="absolute top-0 h-full border-l-2 border-dashed border-[hsl(55_89%_51%)]"
          style={{ left: `${Math.min(Math.max(floorPct, 0), 100)}%` }}
          title={`Protection floor ${floorPct.toFixed(0)}%`}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Safe ({symbol})</span>
          <span>
            {basePct.toFixed(1)}% · {formatAmount(stats.allocation.base, decimals)} {symbol}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Strategy assets</span>
          <span>
            {riskyPct.toFixed(1)}% · {formatAmount(stats.allocation.risky, decimals)} {symbol}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Protection floor</span>
          <span className="text-[hsl(55_89%_51%)]">{floorPct.toFixed(0)}% minimum safe</span>
        </div>
      </div>
    </div>
  );
}
