import {
  rpc,
  Contract,
  Account,
  Address,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "./config.js";

export const server = new rpc.Server(config.rpcUrl, {
  allowHttp: config.rpcUrl.startsWith("http://"),
});

// Ephemeral source account used only to *simulate* read-only calls.
const simSource = Keypair.random().publicKey();

export async function latestLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}

/// Simulate a read-only contract method and return its native return value.
export async function readContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<unknown> {
  const contract = new Contract(contractId);
  const account = new Account(simSource, "0");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : null;
}

export function addressArg(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

/// Reflector `Asset::Other(Symbol)` = Vec[Symbol("Other"), Symbol(sym)].
function reflectorAssetOther(sym: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(sym)]);
}

/// Real recent price history for `symbol` from the Reflector CEX/DEX feed
/// (USD, 14 dp). Returns oldest→newest `[{ ts (unix s), price (USD) }]`.
export async function reflectorPrices(
  reflectorId: string,
  symbol: string,
  records: number
): Promise<{ ts: number; price: number }[]> {
  const raw = (await readContract(reflectorId, "prices", [
    reflectorAssetOther(symbol),
    xdr.ScVal.scvU32(records),
  ])) as { price: bigint; timestamp: bigint }[] | null;
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .map((p) => ({ ts: Number(p.timestamp), price: Number(p.price) / 1e14 }))
    .sort((a, b) => a.ts - b.ts);
}

/// Decode an RPC event topic/value, which may arrive as a base64 XDR string or
/// an already-parsed ScVal, into a native JS value.
export function toNative(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "string") return scValToNative(xdr.ScVal.fromXDR(v, "base64"));
  return scValToNative(v as xdr.ScVal);
}
