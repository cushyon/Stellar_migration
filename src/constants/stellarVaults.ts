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
  /** Decimals of the share token (`decimals()` of the vault): asset decimals + `decimals_offset`. */
  shareDecimals: number;
  /** Symbol of the safe leg the floor is measured in. */
  safeSymbol: string;
  /** Icon of the safe leg. */
  safeIcon: string;
};

const STELLAR_VAULT_1: StellarVaultConfig = {
  name: "XLM Capital Protected",
  vaultId: "cushion",
  // Testnet deployment with the STRIDE fixes (2026-11-24): XLM base and risky
  // leg, Soroswap testnet USDC as the safe leg, Reflector oracle, Soroswap adapter.
  contractId: "CAT5JPUQQAM6QBAHVTJX642S5UN3DFS5BGF3INQCNIU4OBEW4Y33FRTP",
  description:
    "60% capital guarantee and profit lock-in",
  floorBps: 6000,
  safeSymbol: "USDC",
  safeIcon: "/icons/usdc.svg",
  asset: {
    symbol: "XLM",
    decimals: 7,
    icon: "/icons/xlm.svg",
  },
  shareDecimals: 10,
};

export const STELLAR_VAULTS: StellarVaultConfig[] = [STELLAR_VAULT_1];

export function getStellarVaultConfig(
  vaultId: string
): StellarVaultConfig | undefined {
  return STELLAR_VAULTS.find((v) => v.vaultId === vaultId);
}
