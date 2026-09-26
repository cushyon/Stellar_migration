import { config } from "./config.js";

/// Answer of the CPPI engine (`POST /strategy/stellar`).
export interface StrategyAnswer {
  percentageAsset1: number; // risky leg, in % of NAV
  percentageAsset2: number; // safe leg, in % of NAV
  limitOrderPrice: number;
  quantityRisky: number;
  quantitySafe: number;
  newNav: number;
  newMaxNav: number;
  floorValue: number;
  ratchetSteps: number;
}

export interface StrategyRequest {
  price_risky: number;
  price_safe: number;
  nav: number;
  max_nav: number;
  risky_amount: number;
  safe_amount: number;
  initial_capital: number;
}

/// Ask the engine for the target allocation. Values are per share, so a deposit
/// or a withdrawal does not move the result (the CPPI math does not change with
/// the scale). The engine holds no key and never touches the chain.
export async function askEngine(request: StrategyRequest): Promise<StrategyAnswer> {
  const url = `${config.keeper.engineUrl}/strategy/stellar`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(config.keeper.engineTimeoutMs),
  });
  const body = (await response.json()) as StrategyAnswer & { status?: string; message?: string };
  if (!response.ok || body.status === "error") {
    throw new Error(`engine ${response.status}: ${body.message ?? "unknown error"}`);
  }
  return body;
}
