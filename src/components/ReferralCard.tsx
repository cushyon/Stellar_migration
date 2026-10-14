"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatQty } from "@/lib/format";
import { explorerTxUrl } from "@/services/vaultTx";
import {
  fetchReferralCode,
  fetchReferralMessage,
  fetchReferralSummary,
  postReferralClaim,
  type ReferralSummary,
} from "@/services/indexer";

/**
 * Invite card. The vault contract knows nothing about referrals: a referred
 * wallet signs a plain message that names the code, and the indexer keeps the
 * binding with its signature. The referrer then earns a share of the
 * performance fee that its referees pay, in vault shares.
 */
export function ReferralCard({
  vaultId,
  contractId,
  address,
  decimals,
  pendingCode,
  onClaimed,
}: {
  /** Slug of the dashboard route, for the invite link. */
  vaultId: string;
  /** Onchain id of the vault, named in the message that the referee signs. */
  contractId: string;
  address: string | null;
  decimals: number;
  /** Code read from the `?ref=` of the URL, waiting for a signature. */
  pendingCode: string | null;
  onClaimed: () => void;
}) {
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) {
      setSummary(null);
      setCode(null);
      return;
    }
    const [own, picture] = await Promise.all([
      fetchReferralCode(address),
      fetchReferralSummary(address),
    ]);
    setCode(own);
    setSummary(picture);
  }, [address]);

  useEffect(() => {
    load();
  }, [load]);

  const link = code ? `${typeof window === "undefined" ? "" : window.location.origin}/vaults/${vaultId}?ref=${code}` : "";

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const claim = async () => {
    if (!address || !pendingCode) return;
    setClaiming(true);
    setClaimError(null);
    try {
      const asked = await fetchReferralMessage(contractId, address, pendingCode);
      if (!asked) throw new Error("the indexer did not answer");
      const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit");
      const { signedMessage } = await StellarWalletsKit.signMessage(asked.message, { address });
      const result = await postReferralClaim({
        vault: contractId,
        address,
        code: pendingCode,
        issuedAt: asked.issuedAt,
        signature: signedMessage,
      });
      if (!result.ok) throw new Error(result.error);
      onClaimed();
      await load();
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : "the claim failed");
    } finally {
      setClaiming(false);
    }
  };

  if (!address) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-lg font-semibold">Invite</h3>
        <p className="mt-2 text-sm text-gray-400">
          Connect your wallet to get your invite link.
        </p>
      </div>
    );
  }

  const pending = summary?.rewards.pendingShares ?? "0";
  const paid = summary?.rewards.paidShares ?? "0";
  const sharePct = ((summary?.referrerShareBps ?? 0) / 100).toFixed(0);

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">Invite</h3>
        <span className="text-xs text-gray-500">
          You earn {sharePct}% of the performance fee your invitees pay
        </span>
      </div>

      {/* A code from the link, not yet confirmed by a signature. */}
      {pendingCode && !summary?.referredBy && (
        <div className="mt-3 flex flex-col gap-2 rounded border border-neutral-700 bg-neutral-950 p-3">
          <span className="text-sm">
            You arrived with the invite code{" "}
            <span className="font-semibold">{pendingCode}</span>. Confirm it with a signature, before
            your first deposit.
          </span>
          <span className="text-xs text-gray-500">
            The signature costs nothing and sends no transaction. It only proves that this wallet
            accepts the invitation.
          </span>
          <Button
            onClick={claim}
            disabled={claiming}
            className="self-start bg-[linear-gradient(90deg,#123FFC_0%,#4571F4_100%)] px-4"
          >
            {claiming ? "Waiting for the wallet..." : "Confirm the invitation"}
          </Button>
          {claimError && <span className="text-xs text-red-400">{claimError}</span>}
        </div>
      )}

      {summary?.referredBy && (
        <p className="mt-3 text-sm text-gray-400">
          You were invited with the code{" "}
          <span className="text-gray-200">{summary.referredBy.code}</span>
          {summary.referredBy.depositTx ? ", and your first deposit is linked to it." : "."}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <span className="text-sm text-gray-400">Your invite link</span>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-neutral-950 px-3 py-2 text-xs text-gray-300">
            {link || "..."}
          </code>
          <button
            onClick={copy}
            disabled={!link}
            className="rounded-sm bg-[#2a3142] px-3 py-2 text-xs text-gray-200 hover:bg-[#343c52] disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Invited</span>
          <span className="font-semibold text-white">{summary?.referred.length ?? 0}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Pending rewards</span>
          <span className="font-semibold text-white">
            {formatQty(Number(pending) / 10 ** decimals)} shares
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400">Paid</span>
          <span className="font-semibold text-white">
            {formatQty(Number(paid) / 10 ** decimals)} shares
          </span>
        </div>
      </div>

      {summary && summary.rewards.rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="pb-2 pr-4 font-normal">Invitee</th>
                <th className="pb-2 pr-4 font-normal">Reward</th>
                <th className="pb-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {summary.rewards.rows.slice(0, 6).map((row) => (
                <tr key={row.id} className="border-t border-neutral-800">
                  <td className="py-2 pr-4 text-gray-400">
                    {row.referee.slice(0, 4)}...{row.referee.slice(-4)}
                  </td>
                  <td className="py-2 pr-4">
                    {formatQty(Number(row.shares) / 10 ** decimals)} shares
                  </td>
                  <td className="py-2 text-gray-400">
                    {row.status === "paid" && row.payoutTx ? (
                      <a
                        href={explorerTxUrl(row.payoutTx)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-green-400 underline"
                      >
                        paid
                      </a>
                    ) : (
                      row.status
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
