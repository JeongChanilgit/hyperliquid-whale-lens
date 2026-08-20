import type { BinanceExecutionAdapter, SimulationAdapter, SimulationTradeRequest, SimulationTradeResult } from "./types";

/** Safe default implementation for UI exploration before any execution service exists. */
export const localSimulationAdapter: SimulationAdapter = {
  mode: "simulation",
  async simulate(request: SimulationTradeRequest): Promise<SimulationTradeResult> {
    if (!Number.isFinite(request.notionalUsd) || request.notionalUsd <= 0) {
      return { accepted: false, simulatedAt: Date.now(), reason: "notionalUsd must be positive" };
    }
    return { accepted: true, simulatedAt: Date.now() };
  },
};

/**
 * There is intentionally no credential or API-key type here. Browser-based Binance
 * execution is disabled until a server-side signing plus confirmation flow exists.
 */
export const disabledBinanceExecutionAdapter: BinanceExecutionAdapter = {
  venue: "binance",
  enabled: false,
  async execute(): Promise<never> {
    throw new Error("Binance execution is disabled in the browser. Use a future server-side signing flow.");
  },
};
