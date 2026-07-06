"use client";

import { useEffect, useState } from "react";
import {
  fetchVaultStats,
  fetchUserPositions,
  fetchVaultHistory,
  fetchPriceHistory,
  fetchUserPositionHistory,
  type VaultStats,
  type UserPosition,
  type VaultHistoryPoint,
  type PricePoint,
  type PositionHistoryPoint,
} from "@/services/indexer";

const REFRESH_MS = 15_000;

// Data flows tx -> indexer cron -> API poll, so a confirmed tx can take up to
// cron+poll (~45s) to show up. Hooks subscribe here; after a confirmed tx the
// form fires a refresh burst that picks the new snapshot up within seconds.
const listeners = new Set<() => void>();
function subscribeRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function refreshVaultData(): void {
  listeners.forEach((fn) => fn());
}
/** Immediate refresh + a burst covering the indexer's next cron ticks. */
export function refreshVaultDataAfterTx(): void {
  refreshVaultData();
  [5, 12, 20, 32, 45].forEach((s) => setTimeout(refreshVaultData, s * 1000));
}

export function useVaultStats(contractId: string) {
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const s = await fetchVaultStats(contractId);
      if (active) {
        setStats(s);
        setLoading(false);
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId]);

  return { stats, loading };
}

export function useVaultHistory(contractId: string, range: string) {
  const [history, setHistory] = useState<VaultHistoryPoint[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const h = await fetchVaultHistory(contractId, range);
      if (active) setHistory(h);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId, range]);

  return history;
}

export function usePriceHistory(symbol: string, days: number) {
  const [prices, setPrices] = useState<PricePoint[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const p = await fetchPriceHistory(symbol, days);
      if (active) setPrices(p);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [symbol, days]);

  return prices;
}

export function useUserPositionHistory(
  contractId: string,
  address: string | null,
  range: string
) {
  const [history, setHistory] = useState<PositionHistoryPoint[]>([]);

  useEffect(() => {
    if (!address) {
      setHistory([]);
      return;
    }
    let active = true;
    const load = async () => {
      const h = await fetchUserPositionHistory(contractId, address, range);
      if (active) setHistory(h);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId, address, range]);

  return history;
}

export function useUserPosition(contractId: string, address: string | null) {
  const [position, setPosition] = useState<UserPosition | null>(null);

  useEffect(() => {
    if (!address) {
      setPosition(null);
      return;
    }
    let active = true;
    const load = async () => {
      const list = await fetchUserPositions(address);
      if (active) setPosition(list.find((p) => p.vault === contractId) ?? null);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId, address]);

  return position;
}
