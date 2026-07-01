/**
 * Client for the Cushion indexer API (D3). The dashboard reads vault metrics
 * from indexed Postgres here — not live RPC — for sub-second, consistent stats.
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
  };
  ledger: number;
  ts: string;
}

export interface UserPosition {
  vault: string;
  address: string;
  shares: string; // base units (i128 as string)
  updatedAt: string;
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
