export const MAX_TRACKED_WHALES = 5;
export const ZERO_EPSILON = 1e-12;

export const DEFAULT_MIRROR_CONFIG = Object.freeze({
  immediateResidualNotionalUsd: 1,
  targetPositionToleranceBps: 5,
  verificationDelayMs: 250,
  terminalVerificationDelayMs: 1_000,
  maxCatchUpSlippageBps: 50,
  killOnTerminalResidual: true,
});

const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
};

const positive = (value, label) => {
  const number = finite(value, label);
  if (number <= 0) throw new Error(`${label} must be greater than zero`);
  return number;
};

export const normalizeAddress = (value) => {
  const address = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new Error(`Invalid address: ${value}`);
  return address;
};

export const normalizeCoin = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("coin is required");
  const separator = raw.indexOf(":");
  return separator < 0
    ? raw.toUpperCase()
    : `${raw.slice(0, separator).toLowerCase()}:${raw.slice(separator + 1).toUpperCase()}`;
};

export const cloneLeverage = (leverage) => {
  if (!leverage || (leverage.type !== "cross" && leverage.type !== "isolated")) {
    throw new Error("leverage.type must be cross or isolated");
  }
  const value = Math.trunc(positive(leverage.value, "leverage.value"));
  return { type: leverage.type, value };
};

export const positionMarkPrice = (position) => {
  if (Number.isFinite(Number(position.markPriceUsd)) && Number(position.markPriceUsd) > 0) {
    return Number(position.markPriceUsd);
  }
  if (Number.isFinite(Number(position.positionValueUsd)) && Math.abs(Number(position.signedSize)) > ZERO_EPSILON) {
    return Math.abs(Number(position.positionValueUsd) / Number(position.signedSize));
  }
  throw new Error(`No usable mark price for ${position.coin}`);
};

export const signedPositionNotionalUsd = (position) => {
  const signedSize = finite(position.signedSize, `${position.coin}.signedSize`);
  if (Math.abs(signedSize) <= ZERO_EPSILON) return 0;
  const absoluteNotional = Number.isFinite(Number(position.positionValueUsd))
    ? Math.abs(Number(position.positionValueUsd))
    : Math.abs(signedSize) * positionMarkPrice(position);
  return Math.sign(signedSize) * absoluteNotional;
};

export const marginPoolEquityUsd = (snapshot, poolId = "default") => {
  const pools = snapshot?.marginPools ?? {};
  const entries = Object.entries(pools);
  const pool = pools[poolId] ?? (poolId === "default" ? pools.default : undefined);
  if (pool) {
    const equity = Number(pool.equityUsd);
    if (Number.isFinite(equity) && equity > 0) return equity;
    throw new Error(`margin pool ${poolId} has no funded positive equity`);
  }
  if (entries.length > 0) throw new Error(`margin pool ${poolId} is missing from the account snapshot`);
  return positive(snapshot?.accountEquityUsd, "snapshot.accountEquityUsd");
};

export const targetPositionFromSource = ({
  sourcePosition,
  sourceSnapshot,
  targetSnapshot,
}) => {
  if (!sourcePosition) throw new Error("sourcePosition is required");
  const coin = normalizeCoin(sourcePosition.coin);
  const sourceLeverage = cloneLeverage(sourcePosition.leverage);
  const poolId = sourcePosition.poolId ?? "default";
  const sourceEquityUsd = marginPoolEquityUsd(sourceSnapshot, poolId);
  const targetEquityUsd = marginPoolEquityUsd(targetSnapshot, poolId);
  const sourceSignedNotionalUsd = signedPositionNotionalUsd(sourcePosition);
  const exposureRatio = sourceSignedNotionalUsd / sourceEquityUsd;
  const targetSignedNotionalUsd = exposureRatio * targetEquityUsd;
  const markPriceUsd = positionMarkPrice(sourcePosition);
  const targetSignedSize = targetSignedNotionalUsd / markPriceUsd;
  let isolatedMarginRatio = null;
  let targetIsolatedMarginUsd = null;
  if (sourceLeverage.type === "isolated") {
    const sourceMarginUsedUsd = positive(sourcePosition.marginUsedUsd, `${coin}.marginUsedUsd`);
    const sourceAbsoluteNotionalUsd = Math.abs(sourceSignedNotionalUsd);
    if (sourceAbsoluteNotionalUsd <= ZERO_EPSILON) throw new Error(`Cannot scale isolated margin for flat ${coin}`);
    isolatedMarginRatio = sourceMarginUsedUsd / sourceAbsoluteNotionalUsd;
    targetIsolatedMarginUsd = Math.abs(targetSignedNotionalUsd) * isolatedMarginRatio;
  }
  return {
    coin,
    poolId,
    markPriceUsd,
    sourceEquityUsd,
    targetEquityUsd,
    sourceSignedNotionalUsd,
    exposureRatio,
    targetSignedNotionalUsd,
    targetSignedSize,
    leverage: sourceLeverage,
    isolatedMarginRatio,
    targetIsolatedMarginUsd,
  };
};

export const targetFlatPosition = ({ coin, poolId = "default", targetSnapshot, markPriceUsd, leverage }) => ({
  coin: normalizeCoin(coin),
  poolId,
  markPriceUsd: positive(markPriceUsd, "markPriceUsd"),
  sourceEquityUsd: 0,
  targetEquityUsd: marginPoolEquityUsd(targetSnapshot, poolId),
  sourceSignedNotionalUsd: 0,
  exposureRatio: 0,
  targetSignedNotionalUsd: 0,
  targetSignedSize: 0,
  leverage: cloneLeverage(leverage),
  isolatedMarginRatio: leverage.type === "isolated" ? 1 / leverage.value : null,
  targetIsolatedMarginUsd: leverage.type === "isolated" ? 0 : null,
});

export const signedFillQuantity = (fill) => {
  const size = positive(fill.size ?? fill.sz, "fill.size");
  const side = String(fill.side ?? "").toUpperCase();
  if (side === "BUY" || side === "B") return size;
  if (side === "SELL" || side === "A") return -size;
  throw new Error(`Unsupported fill side: ${fill.side}`);
};

export const sourcePositionAfterFill = (fill) => {
  const startPosition = finite(fill.startPosition, "fill.startPosition");
  return startPosition + signedFillQuantity(fill);
};

export const positionSizeForCoin = (snapshot, coin) => {
  const normalized = normalizeCoin(coin);
  const position = (snapshot?.positions ?? []).find((item) => normalizeCoin(item.coin) === normalized);
  return position ? finite(position.signedSize, `${normalized}.signedSize`) : 0;
};

export const scaleSourceOrder = ({ sourceOrder, sourceSnapshot, targetSnapshot, targetPositionSize = 0 }) => {
  const coin = normalizeCoin(sourceOrder.coin);
  const poolId = sourceOrder.poolId ?? "default";
  const sourceEquityUsd = marginPoolEquityUsd(sourceSnapshot, poolId);
  const targetEquityUsd = marginPoolEquityUsd(targetSnapshot, poolId);
  const balanceScale = targetEquityUsd / sourceEquityUsd;
  const sourceRemainingSize = Math.max(0, finite(sourceOrder.remainingSize ?? sourceOrder.size, `${coin}.remainingSize`));
  let targetRemainingSize = sourceRemainingSize * balanceScale;
  const reduceOnly = sourceOrder.reduceOnly === true;
  if (reduceOnly) targetRemainingSize = Math.min(targetRemainingSize, Math.abs(targetPositionSize));
  return {
    sourceOrderId: String(sourceOrder.id ?? sourceOrder.oid),
    clientOrderId: String(sourceOrder.clientOrderId ?? sourceOrder.cloid ?? ""),
    coin,
    poolId,
    side: String(sourceOrder.side).toUpperCase() === "B" ? "BUY" : String(sourceOrder.side).toUpperCase() === "A" ? "SELL" : String(sourceOrder.side).toUpperCase(),
    price: positive(sourceOrder.price ?? sourceOrder.limitPrice ?? sourceOrder.limitPx, `${coin}.price`),
    triggerPrice: sourceOrder.triggerPrice == null ? null : positive(sourceOrder.triggerPrice, `${coin}.triggerPrice`),
    orderType: String(sourceOrder.orderType ?? "LIMIT").toUpperCase(),
    tif: String(sourceOrder.tif ?? "GTC").toUpperCase(),
    reduceOnly,
    sourceRemainingSize,
    targetRemainingSize,
    balanceScale,
    leverage: cloneLeverage(sourceOrder.leverage),
    status: String(sourceOrder.status ?? "OPEN").toUpperCase(),
  };
};

export const reconciliationDelta = ({ desiredSize, actualSize, markPriceUsd, minNotionalUsd = 1, sizeStep = 0 }) => {
  const target = finite(desiredSize, "desiredSize");
  const actual = finite(actualSize, "actualSize");
  const mark = positive(markPriceUsd, "markPriceUsd");
  let delta = target - actual;
  if (sizeStep > 0) {
    const steps = Math.trunc(Math.abs(delta) / sizeStep);
    delta = Math.sign(delta) * steps * sizeStep;
  }
  const notionalUsd = Math.abs(delta) * mark;
  return {
    targetSize: target,
    actualSize: actual,
    deltaSize: notionalUsd + 1e-9 >= minNotionalUsd ? delta : 0,
    rawDeltaSize: target - actual,
    notionalUsd,
    tradeable: notionalUsd + 1e-9 >= minNotionalUsd && Math.abs(delta) > ZERO_EPSILON,
  };
};

export const residualBps = ({ desiredSize, actualSize }) => {
  const desired = Math.abs(finite(desiredSize, "desiredSize"));
  const residual = Math.abs(finite(desiredSize, "desiredSize") - finite(actualSize, "actualSize"));
  if (desired <= ZERO_EPSILON) return residual <= ZERO_EPSILON ? 0 : Number.POSITIVE_INFINITY;
  return residual / desired * 10_000;
};

export const deterministicTargetOrderId = (pairId, sourceOrderId) => {
  const text = `${pairId}|${sourceOrderId}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fmv2-${(hash >>> 0).toString(16).padStart(8, "0")}-${String(sourceOrderId).slice(-12)}`;
};
