"use client";

import { use, useEffect, useState } from "react";
import {
  getStellarVaultConfig,
  type StellarVaultConfig,
} from "@/constants/stellarVaults";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { useVaultStats, useUserPosition } from "@/hooks/useVaultData";
import { formatAmount, formatQty } from "@/lib/format";
import { StellarVaultChart } from "@/components/StellarVaultChart";
import type { VaultStats, UserPosition } from "@/services/indexer";
import {
  invokeVault,
  toBaseUnits,
  fetchNativeBalance,
  explorerTxUrl,
} from "@/services/vaultTx";

type ContentTab = "VaultPerformance" | "UserPerformance";

const CONTENT_TAB_OPTIONS: { value: ContentTab; label: string }[] = [
  { value: "VaultPerformance", label: "Vault Performance" },
  { value: "UserPerformance", label: "Your Performance" },
];

/* ── Stat card (standalone, no Drift deps) ── */
function StatCard({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="flex flex-col flex-1 gap-1 sm:px-4 first:pl-0 last:pr-0 even:border-l even:pl-4 border-neutral-700">
      <span className="text-sm text-gray-400">{label}</span>
      <span className="text-2xl font-semibold">
        {value}
        {suffix && (
          <span className="text-sm text-gray-500 ml-1">{suffix}</span>
        )}
      </span>
    </div>
  );
}

/* ── Vault Performance panel ── */
function VaultPerformancePanel({
  config,
  stats,
}: {
  config: StellarVaultConfig;
  stats: VaultStats | null;
}) {
  const symbol = config.asset.symbol;
  const decimals = config.asset.decimals;
  // Prefer return-since-inception (defined from day one) over the trailing
  // windows, which are null until the vault is old enough.
  const roi =
    stats?.performance.inception ??
    stats?.performance.apy ??
    stats?.performance["30d"] ??
    null;

  return (
    <div className="flex flex-col w-full gap-6">
      {/* Stats row */}
      <div className="grid w-full grid-cols-2 gap-4 p-4 rounded sm:flex sm:gap-0 border border-neutral-800 bg-neutral-900">
        <StatCard
          label="ROI"
          value={roi != null ? (roi * 100).toFixed(2) : "-"}
          suffix="%"
        />
        <StatCard
          label="TVL"
          value={stats ? formatAmount(stats.tvl, decimals) : "-"}
          suffix={symbol}
        />
        <StatCard label="Protection floor" value={`${config.floorBps / 100}`} suffix="%" />
        <StatCard label="Rebalancing" value="1" suffix="Day" />
      </div>

      {/* Performance chart (the product) */}
      <StellarVaultChart
        contractId={config.contractId}
        symbol={symbol}
        decimals={decimals}
      />
    </div>
  );
}

/* ── User Performance panel ── */
function UserPerformancePanel({
  config,
  stats,
  position,
}: {
  config: StellarVaultConfig;
  stats: VaultStats | null;
  position: UserPosition | null;
}) {
  const symbol = config.asset.symbol;
  const decimals = config.asset.decimals;

  // Current value = shares × share price (base units); cost basis isn't tracked
  // onchain, so Deposited / P&L stay at the design's placeholder.
  const shares = position ? BigInt(position.shares) : BigInt(0);
  const currentValue =
    stats && position ? (Number(shares) * stats.sharePrice) / 10 ** decimals : 0;

  return (
    <div className="flex flex-col w-full gap-6">
      <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-lg font-semibold mb-3">Your Position</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-gray-400">Deposited</span>
            <span>0.00 {symbol}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-400">Current Value</span>
            <span>
              {formatQty(currentValue)} {symbol}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-400">P&L</span>
            <span className="text-gray-500">0.00 {symbol}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-400">P&L %</span>
            <span className="text-gray-500">0.00%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Deposit / Withdraw form ── */
function DepositWithdrawForm({
  config,
  stats,
  position,
}: {
  config: StellarVaultConfig;
  stats: VaultStats | null;
  position: UserPosition | null;
}) {
  const symbol = config.asset.symbol;
  const decimals = config.asset.decimals;
  const connected = useStellarWalletStore((s) => s.connected);
  const address = useStellarWalletStore((s) => s.address);
  const [formType, setFormType] = useState<"deposit" | "withdraw">("deposit");
  const [inputAmount, setInputAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [txStatus, setTxStatus] = useState<
    | { kind: "success"; hash: string }
    | { kind: "error"; message: string }
    | null
  >(null);
  const isDeposit = formType === "deposit";

  // wallet XLM balance (deposit max); position value (withdraw max)
  const [walletBalance, setWalletBalance] = useState(0);
  useEffect(() => {
    if (!address) return;
    let active = true;
    const load = async () => {
      const b = await fetchNativeBalance(address);
      if (active) setWalletBalance(b);
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [address, txStatus]);

  const positionValue =
    stats && position
      ? (Number(BigInt(position.shares)) * stats.sharePrice) / 10 ** decimals
      : 0;
  // keep ~2 XLM in the wallet for reserves + fees
  const maxAmount = isDeposit ? Math.max(walletBalance - 2, 0) : positionValue;

  const amount = Number(inputAmount);
  const canSubmit =
    connected &&
    !submitting &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= maxAmount + 1e-9;

  const handleConnect = async () => {
    const { StellarWalletsKit } = await import(
      "@creit-tech/stellar-wallets-kit"
    );
    await StellarWalletsKit.authModal();
  };

  const handleSubmit = async () => {
    if (!address || !canSubmit) return;
    setSubmitting(true);
    setTxStatus(null);
    try {
      const { hash } = await invokeVault(isDeposit ? "deposit" : "withdraw", {
        contractId: config.contractId,
        caller: address,
        amountBase: toBaseUnits(inputAmount, decimals),
      });
      setTxStatus({ kind: "success", hash });
      setInputAmount("");
    } catch (e) {
      setTxStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Transaction failed.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 w-full max-w-[347px] p-5 pb-8 rounded-[20px] bg-neutral-900 grow sm:grow-0">
      {/* Deposit / Withdraw toggle */}
      <div className="flex items-center gap-2 p-1 mb-2 bg-[#2a3142] rounded-full">
        <Button
          onClick={() => setFormType("deposit")}
          className={`flex-1 py-3 px-4 rounded-full text-lg font-medium transition-colors ${
            formType === "deposit"
              ? "!bg-[#475569] !text-gray-200"
              : "!bg-[#2a3142] !text-gray-400"
          }`}
        >
          Deposit
        </Button>
        <Button
          onClick={() => setFormType("withdraw")}
          className={`flex-1 py-3 px-4 rounded-full text-lg font-medium transition-colors ${
            formType === "withdraw"
              ? "!bg-[#475569] !text-gray-200"
              : "!bg-[#2a3142] !text-gray-400"
          }`}
        >
          Withdraw
        </Button>
      </div>

      <div className="flex flex-col gap-4 mt-4">
        <p className="text-sm text-gray-400">
          {isDeposit
            ? "Deposited funds are subject to a 1 day redemption period."
            : "After the 1 day redemption period, your funds can be withdrawn to your wallet."}
        </p>

        {/* Input */}
        <div className="flex flex-col gap-2">
          {connected && (
            <div className="flex items-center justify-between">
              <button
                onClick={() => setInputAmount(maxAmount.toFixed(2))}
                className="flex items-center gap-1 bg-[#2a3142] rounded-sm px-2 py-0.5"
              >
                <span className="text-xs text-gray-400">
                  Max: {formatQty(maxAmount)} {symbol}
                </span>
              </button>
            </div>
          )}

          <div className="flex items-center w-full gap-2">
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-sm font-medium">{symbol}</span>
            </div>
            <Input
              type="number"
              className="w-full text-right bg-transparent text-neutral-300 font-semibold text-2xl placeholder:text-neutral-500"
              placeholder="0.0"
              value={inputAmount}
              onChange={(e) => setInputAmount(e.target.value)}
            />
          </div>
        </div>

        {/* Balance row: wallet balance before -> after the pending amount */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-400">Balance</span>
          <span>
            {formatQty(walletBalance)} {" -> "}
            {formatQty(
              walletBalance + (Number(inputAmount) || 0) * (isDeposit ? -1 : 1)
            )}{" "}
            {symbol}
          </span>
        </div>
      </div>

      {/* Spacer */}
      <div className="grow h-[60px]" />

      {/* tx feedback */}
      {txStatus && (
        <p
          className={`mb-2 text-xs break-all ${
            txStatus.kind === "success" ? "text-green-400" : "text-red-400"
          }`}
        >
          {txStatus.kind === "success" ? (
            <>
              Confirmed onchain.{" "}
              <a
                href={explorerTxUrl(txStatus.hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                View transaction
              </a>
            </>
          ) : (
            txStatus.message
          )}
        </p>
      )}

      {/* CTA */}
      {connected ? (
        <Button
          onClick={handleSubmit}
          className="w-full rounded-full text-white bg-[linear-gradient(90deg,#091BCD_0%,#123FFC_35%,#0B3FE8_64%,#4571F4_100%)] disabled:opacity-50"
          disabled={!canSubmit}
        >
          {submitting
            ? "Confirm in wallet…"
            : isDeposit
              ? "Confirm Deposit"
              : "Request Withdrawal"}
        </Button>
      ) : (
        <Button
          onClick={handleConnect}
          className="w-full rounded-full text-white bg-[linear-gradient(90deg,#091BCD_0%,#123FFC_35%,#0B3FE8_64%,#4571F4_100%)]"
        >
          Connect Wallet
        </Button>
      )}
    </div>
  );
}

/* ── Main page ── */
export default function StellarVaultPage(props: {
  params: Promise<{ vaultId: string }>;
}) {
  const params = use(props.params);
  const vaultConfig = getStellarVaultConfig(params.vaultId);

  const address = useStellarWalletStore((s) => s.address);
  // Hooks run unconditionally (before any early return) - fall back to "" id.
  const { stats } = useVaultStats(vaultConfig?.contractId ?? "");
  const position = useUserPosition(vaultConfig?.contractId ?? "", address);

  const [activeTab, setActiveTab] = useState<ContentTab>("VaultPerformance");

  if (!vaultConfig) {
    return (
      <div className="p-8 text-center">
        <h1 className="text-2xl font-bold">Vault not found</h1>
        <p className="text-gray-400 mt-2">
          No vault configured for ID: {params.vaultId}
        </p>
      </div>
    );
  }

  const symbol = vaultConfig.asset.symbol;

  return (
    <div>
      <h1 className="text-2xl font-bold">{vaultConfig.name}</h1>
      <p className="text-gray-400 mt-1">{vaultConfig.description}</p>

      {/* Tabs */}
      <div className="flex mt-4">
        <ToggleGroup
          type="single"
          value={activeTab}
          onValueChange={(v) => v && setActiveTab(v as ContentTab)}
        >
          {CONTENT_TAB_OPTIONS.map((opt) => (
            <ToggleGroupItem key={opt.value} value={opt.value}>
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {/* Content + Form */}
      <div className="flex flex-col md:flex-row w-full gap-6 mt-4">
        {activeTab === "VaultPerformance" && (
          <VaultPerformancePanel config={vaultConfig} stats={stats} />
        )}
        {activeTab === "UserPerformance" && (
          <UserPerformancePanel
            config={vaultConfig}
            stats={stats}
            position={position}
          />
        )}

        <div className="w-full md:max-w-[400px]">
          <DepositWithdrawForm
            config={vaultConfig}
            stats={stats}
            position={position}
          />
        </div>
      </div>
    </div>
  );
}
