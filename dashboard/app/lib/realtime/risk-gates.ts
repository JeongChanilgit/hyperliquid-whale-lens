import type { CopyIntent, CopyRiskConfig } from "../copy-types";

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
  notionalUsd: number;
  slippageProxyBps?: number;
}

export interface IdempotencyStore {
  acquire(key: string): boolean;
}

export interface RiskGateInitialState {
  killSwitch?: boolean;
  realizedPnlToday?: number;
  lossDay?: string;
}

const utcDay = (time: number): string => new Date(time).toISOString().slice(0, 10);

/** Stateful server-side risk checks. Callers must never substitute client input for this state. */
export class CopyRiskGate {
  private readonly config: CopyRiskConfig;
  private killSwitch: boolean;
  private lossDay = utcDay(Date.now());
  private realizedPnlToday = 0;

  constructor(config: CopyRiskConfig, initial: RiskGateInitialState = {}) {
    if (!Array.isArray(config.allowedSymbols) || config.allowedSymbols.length === 0) throw new Error("Risk config requires a non-empty symbol allowlist");
    if (!Number.isFinite(config.maxNotionalUsd) || config.maxNotionalUsd <= 0) throw new Error("maxNotionalUsd must be positive");
    if (!Number.isFinite(config.maxSlippageProxyBps) || config.maxSlippageProxyBps < 0) throw new Error("maxSlippageProxyBps must be non-negative");
    if (!Number.isFinite(config.maxDailyLossUsd) || config.maxDailyLossUsd <= 0) throw new Error("maxDailyLossUsd must be positive");
    this.config = {
      ...config,
      allowedWhales: config.allowedWhales?.map((address) => address.toLowerCase()),
      allowedSymbols: config.allowedSymbols.map((symbol) => symbol.toUpperCase()),
    };
    this.killSwitch = initial.killSwitch ?? Boolean(config.killSwitch);
    if (initial.lossDay === this.lossDay && Number.isFinite(initial.realizedPnlToday)) {
      this.realizedPnlToday = initial.realizedPnlToday ?? 0;
    }
  }

  evaluate(intent: CopyIntent, venuePrice?: number): RiskDecision {
    this.rotateDay();
    const notionalUsd = intent.notionalUsd;
    if (this.killSwitch) return { allowed: false, reason: "Kill switch is enabled", notionalUsd };
    if (this.config.allowedWhales && !this.config.allowedWhales.includes(intent.whale.toLowerCase())) {
      return { allowed: false, reason: "Source wallet is not in the allowlist", notionalUsd };
    }
    if (!this.config.allowedSymbols.includes("*") && !this.config.allowedSymbols.includes(intent.symbol.toUpperCase())) {
      return { allowed: false, reason: "Symbol is not in the allowlist", notionalUsd };
    }
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || notionalUsd > this.config.maxNotionalUsd) {
      return { allowed: false, reason: "Notional exceeds the configured limit", notionalUsd };
    }
    if (this.realizedPnlToday <= -this.config.maxDailyLossUsd) {
      return { allowed: false, reason: "Daily loss limit has been reached", notionalUsd };
    }
    if (venuePrice !== undefined) {
      if (!Number.isFinite(venuePrice) || venuePrice <= 0 || !Number.isFinite(intent.referencePrice) || intent.referencePrice <= 0) {
        return { allowed: false, reason: "Unable to compute slippage proxy", notionalUsd };
      }
      const slippageProxyBps = Math.abs(venuePrice - intent.referencePrice) / intent.referencePrice * 10_000;
      if (slippageProxyBps > this.config.maxSlippageProxyBps) {
        return { allowed: false, reason: "Slippage proxy exceeds the configured limit", notionalUsd, slippageProxyBps };
      }
      return { allowed: true, notionalUsd, slippageProxyBps };
    }
    return { allowed: true, notionalUsd };
  }

  recordRealizedPnl(pnl: number, time = Date.now()): void {
    this.rotateDay(time);
    if (Number.isFinite(pnl)) this.realizedPnlToday += pnl;
  }

  setKillSwitch(enabled: boolean): void {
    this.killSwitch = enabled;
  }

  snapshot(): { killSwitch: boolean; realizedPnlToday: number; lossDay: string } {
    this.rotateDay();
    return { killSwitch: this.killSwitch, realizedPnlToday: this.realizedPnlToday, lossDay: this.lossDay };
  }

  private rotateDay(time = Date.now()): void {
    const today = utcDay(time);
    if (today !== this.lossDay) {
      this.lossDay = today;
      this.realizedPnlToday = 0;
    }
  }
}

/** Bounded in-process idempotency store; Binance client order IDs add a second safeguard. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];

  acquire(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.order.push(key);
    if (this.order.length > 50_000) {
      const expired = this.order.shift();
      if (expired) this.keys.delete(expired);
    }
    return true;
  }
}
