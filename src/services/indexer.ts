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
  allocation: { base: string; risky: string; basePct: number; riskyPct: number };
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
