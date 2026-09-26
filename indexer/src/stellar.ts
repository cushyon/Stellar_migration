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

/// Error code of a contract revert, for example `Error(Contract, #26)` -> 26.
export function contractErrorCode(message: string): number | null {
  const match = /Error\(Contract, #(\d+)\)/.exec(message);
  return match ? Number(match[1]) : null;
}

/// A contract call that did not go through. `submitted` says whether the
/// transaction reached the network: after that point the trade may be onchain,
/// so a caller must never report it as rejected.
export class ContractCallError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly submitted: boolean,
    readonly hash?: string
  ) {
    super(message);
    this.name = "ContractCallError";
  }
}

/// Sign and send a contract call, then wait for the result. The source account
/// signs, so a `require_auth` on that address needs no extra signature.
export async function invokeContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  secret: string
): Promise<{ hash: string }> {
  const keypair = Keypair.fromSecret(secret);
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: config.keeper.feeStroops,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(config.keeper.deadlineSeconds)
    .build();

  // Before this point nothing reaches the network, so a failure here is a
  // rejection: the vault refused the call.
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const message = `simulate ${method} failed: ${sim.error}`;
    throw new ContractCallError(message, contractErrorCode(sim.error), false);
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new ContractCallError(`send ${method} failed`, null, false, sent.hash);
  }

  // From here the transaction is on the network. Any later error is about
  // reading the result, not about the trade.
  const deadline = Date.now() + config.keeper.confirmTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const got = await server.getTransaction(sent.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: sent.hash };
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new ContractCallError(`tx failed onchain`, null, true, sent.hash);
      }
    } catch (e) {
      if (e instanceof ContractCallError) throw e;
      throw new ContractCallError(
        `sent, but the result could not be read: ${(e as Error).message}`,
        null,
        true,
        sent.hash
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ContractCallError("sent, but not confirmed in time", null, true, sent.hash);
}
