import type { CopyExecutionReconciler } from "../../app/lib/realtime/copy-engine";
import { BinanceUsdMAdapter } from "../../app/lib/realtime/binance-usdm";
import { CopyRunnerStore } from "./database";

const matches = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-8);

/** Refuses to continue after any unknown or mismatched Binance order/position state. */
export class BinanceReconciler implements CopyExecutionReconciler {
  constructor(
    private readonly binance: BinanceUsdMAdapter,
    private readonly store: CopyRunnerStore,
    private readonly requireFlatStart: boolean,
  ) {}

  async preflight(symbols: string[]): Promise<{ ok: boolean; reason?: string }> {
    try {
      if (await this.binance.isHedgeMode()) {
        return { ok: false, reason: "Binance Hedge Mode is unsupported; switch the dedicated copy account to One-way Mode" };
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Unable to verify Binance position mode" };
    }
    const unresolved = this.store.unresolvedOrders();
    if (unresolved.length > 0) return { ok: false, reason: `Unresolved persisted Binance order: ${unresolved[0]?.clientOrderId}` };
    const expected = new Map(this.store.expectedPositions().map((item) => [item.symbol, item.position]));
    for (const symbol of new Set([...symbols, ...expected.keys()])) {
      let actual: number;
      try { actual = await this.binance.getPositionAmount(symbol); }
      catch (error) { return { ok: false, reason: error instanceof Error ? error.message : `Unable to reconcile ${symbol}` }; }
      const target = expected.get(symbol) ?? 0;
      if (!matches(actual, target)) return { ok: false, reason: `Binance position mismatch for ${symbol}: expected ${target}, got ${actual}` };
      if (this.requireFlatStart && !matches(actual, 0)) {
        return { ok: false, reason: `Non-flat persisted position for ${symbol}; manual reconciliation is required before restart` };
      }
    }
    return { ok: true };
  }

  async afterOrder(input: Parameters<CopyExecutionReconciler["afterOrder"]>[0]): Promise<{ ok: boolean; reason?: string }> {
    const sourceKey = `${input.intent.idempotencyKey}:${input.segmentIndex}`;
    // Binance holds one account-level position per symbol in one-way mode. Add
    // this whale segment to the persisted aggregate instead of comparing the
    // venue against a single whale's follower position.
    const signedDelta = input.segment.side === "BUY" ? input.segment.quantity : -input.segment.quantity;
    const expectedPositionAfter = this.store.expectedPosition(input.intent.symbol) + signedDelta;
    this.store.recordBinanceOrder({
      clientOrderId: input.result.clientOrderId,
      symbol: input.intent.symbol,
      sourceKey,
      expectedPosition: expectedPositionAfter,
      status: "PENDING_RECONCILIATION",
      payload: input.result,
    });
    let order;
    try { order = await this.binance.getOrderByClientOrderId(input.intent.symbol, input.result.clientOrderId); }
    catch (error) {
      this.store.recordBinanceOrder({ clientOrderId: input.result.clientOrderId, symbol: input.intent.symbol, sourceKey, expectedPosition: expectedPositionAfter, status: "UNKNOWN", payload: { error: error instanceof Error ? error.message : String(error) } });
      return { ok: false, reason: "Binance order status is unknown; kill switch required" };
    }
    if (!order || order.status !== "FILLED" || order.executedQty === undefined || !matches(order.executedQty, input.segment.quantity)) {
      this.store.recordBinanceOrder({ clientOrderId: input.result.clientOrderId, symbol: input.intent.symbol, sourceKey, expectedPosition: expectedPositionAfter, status: order?.status ?? "UNKNOWN", payload: order ?? {} });
      return { ok: false, reason: `Binance order was not conclusively FILLED for ${input.result.clientOrderId}` };
    }
    let actual: number;
    try { actual = await this.binance.getPositionAmount(input.intent.symbol); }
    catch (error) {
      this.store.recordBinanceOrder({ clientOrderId: input.result.clientOrderId, symbol: input.intent.symbol, sourceKey, expectedPosition: expectedPositionAfter, status: "UNKNOWN", payload: { error: error instanceof Error ? error.message : String(error) } });
      return { ok: false, reason: "Binance position status is unknown; kill switch required" };
    }
    if (!matches(actual, expectedPositionAfter)) {
      this.store.recordBinanceOrder({ clientOrderId: input.result.clientOrderId, symbol: input.intent.symbol, sourceKey, expectedPosition: expectedPositionAfter, status: "POSITION_MISMATCH", payload: { order, actual } });
      return { ok: false, reason: `Binance position mismatch after order: expected ${expectedPositionAfter}, got ${actual}` };
    }
    this.store.setExpectedPosition(input.intent.symbol, actual);
    this.store.recordBinanceOrder({ clientOrderId: input.result.clientOrderId, symbol: input.intent.symbol, sourceKey, expectedPosition: actual, status: "FILLED", payload: order });
    return { ok: true };
  }
}
