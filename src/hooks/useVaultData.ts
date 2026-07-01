"use client";

import { useEffect, useState } from "react";
import {
  fetchVaultStats,
  fetchUserPositions,
  type VaultStats,
  type UserPosition,
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
