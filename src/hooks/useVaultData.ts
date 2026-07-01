"use client";

import { useEffect, useState } from "react";
import {
  fetchVaultStats,
  fetchUserPositions,
  fetchVaultHistory,
  type VaultStats,
  type UserPosition,
  type VaultHistoryPoint,
} from "@/services/indexer";

const REFRESH_MS = 15_000;

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
    return () => {
      active = false;
      clearInterval(t);
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
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [contractId, range]);

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
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [contractId, address]);

  return position;
}
