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
  /** Capital-protection floor in basis points (min base allocation of NAV). */
  floorBps: number;
  asset: StellarAssetConfig;
};

const STELLAR_VAULT_1: StellarVaultConfig = {
  name: "XLM Capital Protected",
  vaultId: "cushion",
  // Testnet deployment (real Reflector oracle wired).
  contractId: "CAH4EGSDBIEJB5TQFH4Q37372UJBY27UN2UBF426YDR2IUVJWACJLBAE",
  description:
    "60% capital guarantee and profit lock-in, invested in XLM with automated rebalancing on Stellar",
  floorBps: 6000,
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
