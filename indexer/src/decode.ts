import { toNative } from "./stellar.js";

export interface DecodedEvent {
  id: string;
  ledger: number;
  ts: Date;
  contractId: string;
  type: string;
  topics: unknown[];
  data: unknown;
}

/// Normalise a raw RPC event into a typed record. The first topic is the event
/// name symbol (deposit / withdraw / transfer / approve / burn / strategy /
/// paused / unpaused).
export function decodeEvent(ev: any): DecodedEvent {
  const rawTopics: unknown[] = ev.topic ?? ev.topics ?? [];
  const topics = rawTopics.map(toNative);
  const data = toNative(ev.value);
  const type = String(topics[0] ?? "unknown");
  return {
    id: String(ev.id),
    ledger: Number(ev.ledger),
    ts: new Date(ev.ledgerClosedAt),
    contractId: typeof ev.contractId === "string" ? ev.contractId : String(ev.contractId),
    type,
    topics,
    data,
  };
}

export interface ShareDelta {
  vault: string;
  address: string;
  delta: bigint;
}

/// Share-supply movements implied by an event, used to maintain user_position.
/// Only events that move share balances contribute.
export function shareDeltas(ev: DecodedEvent): ShareDelta[] {
  const t = ev.topics;
  const d = ev.data as any;
  const vault = ev.contractId;
  switch (ev.type) {
    case "deposit": {
      // topics [deposit, from, receiver], data [assets, shares]
      const receiver = String(t[2]);
      return [{ vault, address: receiver, delta: BigInt(d[1]) }];
    }
    case "withdraw": {
      // topics [withdraw, owner, receiver], data [assets, shares]
      const owner = String(t[1]);
      return [{ vault, address: owner, delta: -BigInt(d[1]) }];
    }
    case "transfer": {
      // topics [transfer, from, to], data amount
      const from = String(t[1]);
      const to = String(t[2]);
      const amt = BigInt(d);
      return [
        { vault, address: from, delta: -amt },
        { vault, address: to, delta: amt },
      ];
    }
    case "burn": {
      // topics [burn, from], data amount
      return [{ vault, address: String(t[1]), delta: -BigInt(d) }];
    }
    default:
      return [];
  }
}
