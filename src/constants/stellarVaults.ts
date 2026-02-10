export type StellarAssetConfig = {
  symbol: string;
  decimals: number;
  icon: string;
};

export type StellarVaultConfig = {
  name: string;
  vaultId: string;
  description: string;
  asset: StellarAssetConfig;
};

const STELLAR_VAULT_1: StellarVaultConfig = {
  name: "XLM Capital Protected",
  vaultId: "test-vault-1",
  description:
    "60% capital guarantee and profit lock-in, invested in XLM with automated rebalancing on Stellar",
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
