import type {
  EventSegment,
  HistoricalOrder,
  HyperliquidFill,
  PositionAction,
  PositionDirection,
  TradingEpisode,
  TradingEvent,
} from "./types";

const ZERO_EPSILON = 1e-9;

const numberOrZero = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normaliseZero = (value: number): number => (Math.abs(value) <= ZERO_EPSILON ? 0 : value);
const directionFor = (position: number): PositionDirection => (position > 0 ? "LONG" : "SHORT");
const actionFor = (direction: PositionDirection, action: "ENTRY" | "ADD" | "REDUCE" | "CLOSE"): PositionAction => `${direction}_${action}`;
const actionLabel = (action: PositionAction): string => action.replace("_", " ");
const orderId = (order: HistoricalOrder): string | undefined => {
  const value = order.order?.oid ?? order.oid;
  return value === undefined || value === null ? undefined : String(value);
};

const indexedOrders = (orders: HistoricalOrder[]): Map<string, HistoricalOrder> => {
  const index = new Map<string, HistoricalOrder>();
  for (const order of orders) {
    const id = orderId(order);
    if (id) index.set(id, order);
  }
  return index;
};

const isStopOrder = (order: HistoricalOrder | undefined): boolean => {
  if (!order) return false;
  const values = [
    order.order?.orderType,
    order.orderType,
    order.order?.triggerCondition,
    order.triggerCondition,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /\bstop\b|\bsl\b|stop[- ]?loss/.test(values);
};

interface ActiveEpisode {
  episode: TradingEpisode;
  expectedPosition: number;
}

export interface EventClassificationResult {
  events: TradingEvent[];
  episodes: TradingEpisode[];
  warnings: string[];
}

const createEpisode = (
  coin: string,
  position: number,
  entryTime: number | undefined,
  openedWithinWindow: boolean,
  id: string,
): TradingEpisode => ({
  id,
  coin,
  direction: directionFor(position),
  status: openedWithinWindow ? "OPEN" : "CARRY_IN",
  entryTime,
  openedWithinWindow,
  // A within-window opening fill is added by appendToEpisode below. Carry-in
  // exposure has no observed opening fill, so retain its known starting size.
  entrySize: openedWithinWindow ? 0 : Math.abs(position),
  exitSize: 0,
  closedPnl: 0,
  fee: 0,
  netPnl: 0,
  fillIds: [],
});

const appendToEpisode = (
  episode: TradingEpisode,
  fillId: string,
  fee: number,
  closedPnl: number,
  entrySize = 0,
  exitSize = 0,
): void => {
  episode.fillIds.push(fillId);
  episode.entrySize += entrySize;
  episode.exitSize += exitSize;
  episode.fee += fee;
  episode.closedPnl += closedPnl;
  episode.netPnl = episode.closedPnl - episode.fee;
};

/**
 * Uses `startPosition` as the source of truth and intentionally never sorts ties
 * by order id/trade id. That preserves Hyperliquid's same-millisecond position chain.
 */
export const classifyTradingEvents = (fills: HyperliquidFill[], orders: HistoricalOrder[] = []): EventClassificationResult => {
  const orderById = indexedOrders(orders);
  const ordered = fills.map((fill, sourceIndex) => ({ fill, sourceIndex })).sort((a, b) => a.fill.time - b.fill.time || a.sourceIndex - b.sourceIndex);
  const events: TradingEvent[] = [];
  const episodes: TradingEpisode[] = [];
  const activeByCoin = new Map<string, ActiveEpisode>();
  const warnings: string[] = [];
  let episodeSequence = 0;

  for (const { fill, sourceIndex } of ordered) {
    // One Hyperliquid transaction hash can contain many fills (and the zero hash
    // is reused by some system fills), so a hash alone is not a row identity.
    // Keep the API order index as the final discriminator for exact duplicates.
    const fillId = [
      fill.hash ?? "no-hash",
      fill.tid ?? "no-tid",
      fill.oid ?? "no-oid",
      fill.coin,
      fill.time,
      sourceIndex,
    ].join(":");
    const startPosition = normaliseZero(numberOrZero(fill.startPosition));
    const size = Math.abs(numberOrZero(fill.sz));
    const delta = fill.side === "B" ? size : -size;
    const endPosition = normaliseZero(startPosition + delta);
    const closedPnl = numberOrZero(fill.closedPnl);
    const fee = numberOrZero(fill.fee);
    const order = fill.oid === undefined ? undefined : orderById.get(String(fill.oid));
    const active = activeByCoin.get(fill.coin);
    let integrityIssue: string | undefined;

    if (active && Math.abs(active.expectedPosition - startPosition) > ZERO_EPSILON) {
      integrityIssue = `Position discontinuity: expected ${active.expectedPosition}, received ${startPosition}`;
      warnings.push(`${fill.coin} at ${fill.time}: ${integrityIssue}`);
    }
    if (!active && startPosition !== 0) {
      const carry = createEpisode(fill.coin, startPosition, undefined, false, `episode-${episodeSequence++}`);
      episodes.push(carry);
      activeByCoin.set(fill.coin, { episode: carry, expectedPosition: startPosition });
    }

    const current = activeByCoin.get(fill.coin);
    const actions: PositionAction[] = [];
    const segments: EventSegment[] = [];
    const closing = startPosition !== 0 && (endPosition === 0 || Math.sign(startPosition) !== Math.sign(endPosition));
    const lossClose = closing && closedPnl < 0;
    const triggerStop = closing && isStopOrder(order);

    if (startPosition === 0 && endPosition !== 0) {
      const episode = createEpisode(fill.coin, endPosition, fill.time, true, `episode-${episodeSequence++}`);
      episodes.push(episode);
      appendToEpisode(episode, fillId, fee, closedPnl, Math.abs(endPosition));
      activeByCoin.set(fill.coin, { episode, expectedPosition: endPosition });
      const action = actionFor(episode.direction, "ENTRY");
      actions.push(action);
      segments.push({ action, direction: episode.direction, size: Math.abs(endPosition), episodeId: episode.id });
    } else if (startPosition !== 0 && current) {
      const sameDirection = endPosition === 0 || Math.sign(startPosition) === Math.sign(endPosition);
      const direction = directionFor(startPosition);
      if (sameDirection) {
        const grew = Math.abs(endPosition) > Math.abs(startPosition);
        const action = actionFor(direction, endPosition === 0 ? "CLOSE" : grew ? "ADD" : "REDUCE");
        const entered = grew ? Math.abs(endPosition) - Math.abs(startPosition) : 0;
        const exited = grew ? 0 : Math.abs(startPosition) - Math.abs(endPosition);
        appendToEpisode(current.episode, fillId, fee, closedPnl, entered, exited);
        actions.push(action);
        segments.push({ action, direction, size: grew ? entered : exited, episodeId: current.episode.id });
        if (endPosition === 0) {
          current.episode.status = current.episode.openedWithinWindow ? "COMPLETED" : "CARRY_IN";
          current.episode.exitTime = fill.time;
          activeByCoin.delete(fill.coin);
        } else {
          current.expectedPosition = endPosition;
        }
      } else {
        // One fill crosses flat: finish the old episode and begin a new one.
        const oldSize = Math.abs(startPosition);
        const newSize = Math.abs(endPosition);
        const totalSize = oldSize + newSize;
        const oldFee = totalSize > 0 ? fee * (oldSize / totalSize) : fee;
        const newFee = fee - oldFee;
        const oldAction = actionFor(direction, "CLOSE");
        appendToEpisode(current.episode, fillId, oldFee, closedPnl, 0, oldSize);
        current.episode.status = current.episode.openedWithinWindow ? "COMPLETED" : "CARRY_IN";
        current.episode.exitTime = fill.time;
        actions.push(oldAction);
        segments.push({ action: oldAction, direction, size: oldSize, episodeId: current.episode.id });

        const next = createEpisode(fill.coin, endPosition, fill.time, true, `episode-${episodeSequence++}`);
        episodes.push(next);
        appendToEpisode(next, fillId, newFee, 0, newSize);
        activeByCoin.set(fill.coin, { episode: next, expectedPosition: endPosition });
        const newAction = actionFor(next.direction, "ENTRY");
        actions.push(newAction);
        segments.push({ action: newAction, direction: next.direction, size: newSize, episodeId: next.id });
      }
    } else {
      integrityIssue ??= "Fill does not establish a valid non-zero position";
      warnings.push(`${fill.coin} at ${fill.time}: ${integrityIssue}`);
    }

    const labels = actions.map(actionLabel);
    if (lossClose) labels.push("LOSS CLOSE");
    if (triggerStop) labels.push("TRIGGER STOP");
    const closeAction = actions.find((action) => action.endsWith("_CLOSE"));
    const displayLabel = triggerStop && closeAction
      ? `${closeAction.replace("_CLOSE", "").replace("_", " ")} TRIGGER STOP`
      : lossClose && closeAction
        ? `${closeAction.replace("_CLOSE", "").replace("_", " ")} LOSS CLOSE`
        : labels.join(" / ");
    events.push({
      id: fillId,
      coin: fill.coin,
      time: fill.time,
      fill,
      startPosition,
      endPosition,
      actions,
      segments,
      labels,
      displayLabel,
      closedPnl,
      fee,
      isLossClose: lossClose,
      isTriggerStop: triggerStop,
      ...(order ? { order } : {}),
      ...(integrityIssue ? { integrityIssue } : {}),
    });
  }

  return { events, episodes, warnings };
};
