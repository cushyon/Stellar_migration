"use client";

import { useEffect, useRef } from "react";
import useStellarWalletStore from "@/stores/useStellarWalletStore";

/**
 * Client-only component that initialises the Stellar Wallets Kit.
 * All kit imports are dynamic to guarantee zero server-side evaluation.
 * MUST be imported exclusively via next/dynamic with { ssr: false }.
 */
export default function StellarClientOnly({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialized = useRef(false);
  const setStore = useStellarWalletStore((s) => s.set);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    (async () => {
      const [{ StellarWalletsKit, KitEventType }, { defaultModules }] =
        await Promise.all([
          import("@creit-tech/stellar-wallets-kit"),
          import("@creit-tech/stellar-wallets-kit/modules/utils"),
        ]);

      StellarWalletsKit.init({
        modules: defaultModules(),
      });

      StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event: any) => {
        const addr = event.payload.address ?? null;
        setStore((s) => {
          s.address = addr;
          s.connected = !!addr;
        });
      });

      StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
        setStore((s) => {
          s.address = null;
          s.connected = false;
        });
      });
    })();
  }, [setStore]);

  return <>{children}</>;
}
