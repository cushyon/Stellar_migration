/**
 * Client for the Cushion indexer API (D3). The dashboard reads vault metrics
 * from indexed Postgres here - not live RPC - for sub-second, consistent stats.
 */
const BASE =
  process.env.NEXT_PUBLIC_INDEXER_URL?.replace(/\/$/, "") ?? "http://localhost:8080";

export interface VaultStats {
  vaultId: string;
  tvl: string; // base units (i128 as string)
  sharePrice: number;
  allocation: {
    base: string;
    risky: string;
    basePct: number;
    riskyPct: number;
    safeIsBase: boolean; // the safe leg is the base asset, or the other token
    safePct: number;
    strategyPct: number;
  };
  performance: {
    "30d": number | null;
    "60d": number | null;
    "90d": number | null;
    apy: number | null;
    inception: number | null; // return since first non-zero-price snapshot
  };
  ledger: number;
  ts: string;
}

export interface UserPosition {
  vault: string;
  address: string;
  shares: string; // base units (i128 as string)
  deposited: string; // net assets contributed (deposits - withdrawals), base units
  updatedAt: string;
}

export interface VaultHistoryPoint {
  ts: string;
  ledger: number;
  nav: string; // base units
  totalShares: string;
  sharePrice: number;
  allocBase: string;
  allocRisky: string;
}

export async function fetchVaultHistory(
  contractId: string,
  range: string
): Promise<VaultHistoryPoint[]> {
  try {
    const res = await fetch(`${BASE}/vaults/${contractId}/history?range=${range}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as VaultHistoryPoint[];
  } catch {
    return [];
  }
}

export interface PricePoint {
  ts: number; // unix seconds
  price: number; // USD
}

export interface PositionHistoryPoint {
  ts: string;
  value: number; // position value, base units (shares × share price)
}

export async function fetchUserPositionHistory(
  contractId: string,
  address: string,
  range: string
): Promise<PositionHistoryPoint[]> {
  try {
    const res = await fetch(
      `${BASE}/users/${address}/vaults/${contractId}/history?range=${range}`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];
    return (await res.json()) as PositionHistoryPoint[];
  } catch {
    return [];
  }
}

export async function fetchPriceHistory(symbol: string, days: number): Promise<PricePoint[]> {
  try {
    const res = await fetch(`${BASE}/prices/${symbol}?days=${days}`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as PricePoint[];
  } catch {
    return [];
  }
}

export async function fetchVaultStats(contractId: string): Promise<VaultStats | null> {
  try {
    const res = await fetch(`${BASE}/vaults/${contractId}/stats`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as VaultStats;
  } catch {
    return null;
  }
}

export async function fetchUserPositions(address: string): Promise<UserPosition[]> {
  try {
    const res = await fetch(`${BASE}/users/${address}/positions`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as UserPosition[];
  } catch {
    return [];
  }
}

export interface VaultRisk {
  vault: string;
  ts: string;
  nav: string;
  sharePrice: number;
  basePct: number; // share of the NAV held in the base asset
  floorPct: number; // floor as a fraction of the epoch start value
  valuePct: number | null; // share value as a fraction of the epoch start value
  cushionPct: number; // (value - floor) / start value
  epochActive: boolean;
  stopped: boolean; // the value reached the floor: the strategy only sells now
  oracleOk: boolean;
  paused: boolean;
  alerts: string[];
}

export interface StrategyRun {
  id: number;
  vault: string;
  ts: string;
  action: "hold" | "buy_risky" | "sell_risky";
  status: "skipped" | "submitted" | "rejected" | "unknown";
  targetRiskyPct: number | null;
  actualRiskyPct: number | null;
  amountIn: string | null;
  minOut: string | null;
  nonce: number | null;
  txHash: string | null;
  errorCode: number | null;
  detail: string | null;
}

/** Latest risk picture of the vault. Null while the keeper has written none. */
export async function fetchVaultRisk(contractId: string): Promise<VaultRisk | null> {
  try {
    const res = await fetch(`${BASE}/vaults/${contractId}/risk`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { latest: VaultRisk };
    return body.latest;
  } catch {
    return null;
  }
}

/** Recent strategy decisions, newest first. `tradesOnly` leaves out the hold rows. */
export async function fetchStrategyRuns(
  contractId: string,
  limit = 8,
  tradesOnly = false
): Promise<StrategyRun[]> {
  try {
    const query = `limit=${limit}${tradesOnly ? "&trades=1" : ""}`;
    const res = await fetch(`${BASE}/vaults/${contractId}/strategy-runs?${query}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as StrategyRun[];
  } catch {
    return [];
  }
}

/* ── Referral ──────────────────────────────────────────────────────────────
   The vault contract does not know about referrals. A referred wallet signs a
   plain message that names the code, and the indexer keeps the binding with
   its signature, so anyone can repeat the check. */

export interface ReferralSummary {
  address: string;
  code: string | null;
  referrerShareBps: number;
  referred: { vault: string; referee: string; depositTx: string | null; claimedAt: string; ts: string | null }[];
  rewards: {
    pendingShares: string;
    paidShares: string;
    rows: {
      id: number;
      vault: string;
      referee: string;
      shares: string;
      status: string;
      payoutTx: string | null;
      ts: string;
    }[];
  };
  referredBy: { vault: string; referrer: string; code: string; depositTx: string | null } | null;
}

/** The referral code of a wallet. The indexer creates it on the first call. */
export async function fetchReferralCode(address: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/referrals/code/${address}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { code: string }).code;
  } catch {
    return null;
  }
}

export async function fetchReferralSummary(address: string): Promise<ReferralSummary | null> {
  try {
    const res = await fetch(`${BASE}/users/${address}/referrals`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ReferralSummary;
  } catch {
    return null;
  }
}

/** The message that the wallet must sign to claim a code. */
export async function fetchReferralMessage(
  vault: string,
  address: string,
  code: string
): Promise<{ issuedAt: number; message: string } | null> {
  try {
    const url = `${BASE}/referrals/message?vault=${vault}&address=${address}&code=${code}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as { issuedAt: number; message: string };
  } catch {
    return null;
  }
}

/** Send the signed claim. Returns the error text of the indexer when refused. */
export async function postReferralClaim(input: {
  vault: string;
  address: string;
  code: string;
  issuedAt: number;
  signature: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${BASE}/referrals/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: String(body?.error ?? "the claim was refused") };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
