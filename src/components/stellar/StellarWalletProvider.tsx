"use client";

import dynamic from "next/dynamic";

const StellarClientOnly = dynamic(
  () => import("@/components/stellar/StellarClientOnly"),
  { ssr: false }
);

/**
 * Wraps children with the Stellar Wallets Kit initialisation.
 * Safe to import statically — the heavy lifting is deferred
 * to StellarClientOnly which is loaded with ssr: false.
 */
export default function StellarWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <StellarClientOnly>{children}</StellarClientOnly>;
}
