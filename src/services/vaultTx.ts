/**
 * Onchain vault interactions signed by the user's wallet (Stellar Wallets Kit).
 * Flow: build invoke tx -> simulate/assemble (RPC) -> sign (wallet) -> send -> poll.
 * The dapp never touches a secret key; auth is `require_auth(from|owner)` onchain.
 */
import {
  rpc,
  TransactionBuilder,
  Contract,
  BASE_FEE,
  nativeToScVal,
  Address,
} from "@stellar/stellar-sdk";

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx";

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_TX}/${hash}`;
}

/** "12.34" -> 123400000n (string math; no float drift). */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const [int, frac = ""] = amount.trim().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(int || "0") * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || "0")
  );
}

/**
 * Native XLM balance of an account. `funded` is false when the account does
 * not exist on this network yet (Horizon answers 404): on testnet that is a
 * wallet that never received test XLM, not an empty wallet.
 */
export async function fetchNativeBalance(
  address: string
): Promise<{ balance: number; funded: boolean }> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`, { cache: "no-store" });
    if (res.status === 404) return { balance: 0, funded: false };
    if (!res.ok) return { balance: 0, funded: true };
    const acc = (await res.json()) as {
      balances: { asset_type: string; balance: string }[];
    };
    const native = acc.balances.find((b) => b.asset_type === "native");
    return { balance: native ? Number(native.balance) : 0, funded: true };
  } catch {
    return { balance: 0, funded: true };
  }
}

/** Testnet only: ask Friendbot to create and fund the account with test XLM. */
export async function fundWithFriendbot(address: string): Promise<boolean> {
  try {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
    return res.ok;
  } catch {
    return false;
  }
}

function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // surface the contract error code when present, e.g. "Error(Contract, #13)"
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m) return `Vault rejected the call (error #${m[1]}).`;
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
}

/**
 * Invoke `deposit(from, assets, receiver)` or `withdraw(owner, assets, receiver)`
 * with the connected wallet as caller and receiver. Resolves to the tx hash.
 */
export async function invokeVault(
  method: "deposit" | "withdraw",
  opts: { contractId: string; caller: string; amountBase: bigint }
): Promise<{ hash: string }> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(opts.caller);
  const contract = new Contract(opts.contractId);

  const args = [
    new Address(opts.caller).toScVal(), // from / owner
    nativeToScVal(opts.amountBase, { type: "i128" }), // assets
    new Address(opts.caller).toScVal(), // receiver
  ];

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  let prepared;
  try {
    // simulates, attaches soroban data + auth, bumps fee
    prepared = await server.prepareTransaction(tx);
  } catch (e) {
    throw new Error(readableError(e));
  }

  const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit");
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(prepared.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: opts.caller,
  });

  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`Submission failed (${sent.status}).`);
  }

  // poll until the ledger includes it (~5s close time)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === "SUCCESS") return { hash: sent.hash };
    if (res.status === "FAILED") throw new StaleQuoteError(sent.hash);
  }
  throw new Error("Timed out waiting for confirmation.");
}

/**
 * The transaction was simulated, signed, then refused by the network with no
 * state change. The usual cause: the price feed published a new round while
 * the wallet was open, so the signed transaction reads ledger entries that its
 * simulation did not declare. Signing again with a fresh simulation passes.
 */
export class StaleQuoteError extends Error {
  hash: string;
  constructor(hash: string) {
    super("The price feed moved while you were signing. Please sign once more.");
    this.name = "StaleQuoteError";
    this.hash = hash;
  }
}
