export type StellarAssetConfig = {
  symbol: string;
  decimals: number;
  icon: string;
};

export type StellarVaultConfig = {
  name: string;
  /** URL slug for the dashboard route. */
  vaultId: string;
  /** Onchain Soroban contract id - what the indexer API is keyed on. */
  contractId: string;
  description: string;
  /** Protected share of the value at the start of an epoch, in basis points. */
  floorBps: number;
  asset: StellarAssetConfig;
  /** Symbol of the safe leg the floor is measured in. */
  safeSymbol: string;
};

const STELLAR_VAULT_1: StellarVaultConfig = {
  name: "XLM Capital Protected",
  vaultId: "cushion",
  // Testnet deployment with the value floor (2026-09-29): XLM base and risky
  // leg, Soroswap testnet USDC as the safe leg, Reflector oracle, Soroswap adapter.
  contractId: "CCY7NP6KLDWLPC2IKJYSKSXJPHAZWZPNHONBYVLYKRSHKN5KMPPVWVP6",
  description:
    "60% capital guarantee and profit lock-in, invested in XLM with automated rebalancing on Stellar",
  floorBps: 6000,
  safeSymbol: "USDC",
  asset: {
    symbol: "XLM",
    decimals: 7,
    icon: "/icons/xlm.svg",
  },
};

export const STELLAR_VAULTS: StellarVaultConfig[] = [STELLAR_VAULT_1];

export function getStellarVaultConfig(
  vaultId: string
): StellarVaultConfig | undefined {
  return STELLAR_VAULTS.find((v) => v.vaultId === vaultId);
}
