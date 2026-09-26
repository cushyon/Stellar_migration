"use client";

import type { StrategyRun, VaultRisk } from "@/services/indexer";
import { formatAmount } from "@/lib/format";
import { explorerTxUrl } from "@/services/vaultTx";

const ACTION_LABEL: Record<StrategyRun["action"], string> = {
  hold: "Hold",
  buy_risky: "Buy strategy assets",
  sell_risky: "Sell to safe asset",
};

const STATUS_STYLE: Record<StrategyRun["status"], string> = {
  submitted: "text-green-400",
  rejected: "text-red-400",
  unknown: "text-yellow-400",
  dry_run: "text-gray-400",
  skipped: "text-gray-500",
};

const STATUS_LABEL: Record<StrategyRun["status"], string> = {
  submitted: "executed onchain",
  rejected: "refused by the vault",
  unknown: "sent, not confirmed",
  dry_run: "simulated",
  skipped: "no trade",
};

// Why the vault refused a trade, in the words of its own rules.
const REFUSAL_REASON: Record<number, string> = {
  20: "caller is not the operator",
  21: "asset not on the allowlist",
  22: "trade above the size cap",
  23: "too soon after the last trade",
  24: "output under the operator floor",
  26: "wrong nonce",
  27: "deadline passed",
  28: "would break the protection floor",
  29: "venue not on the allowlist",
  40: "price feed too old",
  41: "price feed disagrees with itself",
  43: "output under the oracle price",
  1000: "vault is paused",
};

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * What the strategy did, and whether the vault let it. Rows come from the
 * keeper: every cycle is recorded, including the ones that traded nothing, so a
 * quiet strategy can be told apart from a strategy that never ran.
 */
export function StrategyActivity({
  runs,
  risk,
  symbol,
  decimals,
}: {
  runs: StrategyRun[];
  risk: VaultRisk | null;
  symbol: string;
  decimals: number;
}) {
  // A cycle that trades nothing is operator detail. Show the trades and the
  // refusals, and say when the strategy last looked at the vault.
  const trades = runs.filter((run) => run.action !== "hold").slice(0, 6);
  const lastCheck = runs[0];
  const cushion = risk ? risk.cushionPct * 100 : null;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">Strategy activity</h3>
        {risk && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className={risk.paused ? "text-yellow-400" : "text-gray-400"}>
              {risk.paused ? "Vault paused" : "Vault active"}
            </span>
            <span className={risk.oracleOk ? "text-gray-400" : "text-red-400"}>
              {risk.oracleOk ? "Price feed ok" : "Price feed unavailable"}
            </span>
            {cushion != null && (
              <span className={cushion >= 0 ? "text-gray-400" : "text-red-400"}>
                {Math.abs(cushion).toFixed(1)} points {cushion >= 0 ? "above" : "below"} the floor
              </span>
            )}
          </div>
        )}
      </div>

      {lastCheck && (
        <p className="mt-2 text-xs text-gray-500">
          Strategy last checked the vault {timeAgo(lastCheck.ts)}.
        </p>
      )}

      {trades.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">
          No trade recorded yet.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="pb-2 pr-4 font-normal">When</th>
                <th className="pb-2 pr-4 font-normal">Action</th>
                <th className="pb-2 pr-4 font-normal">Target</th>
                <th className="pb-2 pr-4 font-normal">Size</th>
                <th className="pb-2 font-normal">Result</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((run) => (
                <tr key={run.id} className="border-t border-neutral-800">
                  <td className="py-2 pr-4 text-gray-400">{timeAgo(run.ts)}</td>
                  <td className="py-2 pr-4">{ACTION_LABEL[run.action]}</td>
                  <td className="py-2 pr-4 text-gray-400">
                    {run.targetRiskyPct != null ? `${run.targetRiskyPct.toFixed(0)}% strategy` : "-"}
                  </td>
                  <td className="py-2 pr-4 text-gray-400">
                    {run.amountIn ? `${formatAmount(run.amountIn, decimals)} ${symbol}` : "-"}
                  </td>
                  <td className={`py-2 ${STATUS_STYLE[run.status]}`}>
                    {STATUS_LABEL[run.status]}
                    {run.errorCode != null &&
                      `: ${REFUSAL_REASON[run.errorCode] ?? `error ${run.errorCode}`}`}
                    {run.txHash && (
                      <>
                        {" "}
                        <a
                          href={explorerTxUrl(run.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          view
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
