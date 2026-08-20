/**
 * Pure, fail-closed planner for replaying the still-open source episode for
 * each current position. The caller must supply unaggregated, de-duplicated
 * Hyperliquid fills with complete retention coverage; this module verifies the
 * inventory chain but cannot prove that upstream coverage was complete.
 */

const EPSILON = 1e-9;
const MAX_SAME_MILLISECOND_FILLS = 16;

export type OpenEpisodeReplayBlockReason =
  | "INVALID_BOOTSTRAP_SCALE"
  | "INVALID_SOURCE_POSITION"
  | "DUPLICATE_SOURCE_POSITION"
  | "INVALID_FILL"
  | "CONFLICTING_FILL_IDENTITY"
  | "SAME_MILLISECOND_ORDER_AMBIGUOUS"
  | "POSITION_CONTINUITY_MISMATCH"
  | "MISSING_FLAT_BOUNDARY"
  | "EPISODE_CLOSED_BEFORE_SNAPSHOT"
  | "AVERAGE_ENTRY_PRICE_MISMATCH"
  | "FINAL_POSITION_MISMATCH";

/** A very small tolerance for rounding differences in the source-reported average entry. */
export const OPEN_EPISODE_ENTRY_PRICE_RELATIVE_TOLERANCE = 1e-6;

export interface OpenEpisodeSourcePosition {
  /** Default-DEX coins remain unprefixed; HIP-3 coins must retain `dex:coin`. */
  coin: string;
  szi: number | string;
  entryPx?: number | string;
  /** Accepted for direct use with the existing realtime account-state shape. */
  entryPriceUsd?: number | string;
}

export interface OpenEpisodeSourceFill {
  coin: string;
  startPosition: number | string;
  side: "B" | "A";
  sz: number | string;
  px: number | string;
  time: number | string;
  hash: string;
  oid: number | string;
  tid: number | string;
  fee?: number | string;
}

export interface OpenEpisodeReplayInput {
  sourcePositions: OpenEpisodeSourcePosition[];
  fills: OpenEpisodeSourceFill[];
  followerAllocationUsd: number | string;
  sourceTotalEquityUsd: number | string;
}

export interface OpenEpisodeReplayBlockedCoin {
  coin: string;
  reason: OpenEpisodeReplayBlockReason;
  detail: string;
}

export interface OpenEpisodeReplayStep {
  id: string;
  coin: string;
  time: number;
  sequence: number;
  kind: "ENTRY" | "ADD" | "PARTIAL_EXIT";
  /** Position reported by Hyperliquid for the complete source fill. */
  fillStartPosition: number;
  /** Position inside this open episode after segmenting an opening reversal. */
  sourcePositionBefore: number;
  sourcePositionAfter: number;
  fullFillSize: number;
  replayedSourceDelta: number;
  replayedFollowerDelta: number;
  price: number;
  sourceFee?: number;
  replayedFee?: number;
  /** This fill belonged to a documented atomic batch with a synthesized internal inventory chain. */
  synthesizedWithinMillisecond?: boolean;
  /** Full normalized source fill. Feed this, not the attributed segment, to CopySimulationLedger.apply. */
  fill: {
    coin: string;
    startPosition: string;
    side: "B" | "A";
    sz: string;
    px: string;
    time: number;
    hash: string;
    oid: number | string;
    tid: number | string;
    fee: string;
  };
  hash: string;
  oid: number | string;
  tid: number | string;
}

export interface OpenEpisodeReplayEpisode {
  id: string;
  coin: string;
  direction: "LONG" | "SHORT";
  boundary: "FLAT" | "REVERSAL";
  sourceEntryPrice: number;
  replayedAverageEntryPrice: number;
  entryTime: number;
  sourcePosition: number;
  followerPosition: number;
  fills: OpenEpisodeReplayStep[];
}

export interface OpenEpisodeReplayReconciliationPosition {
  coin: string;
  snapshotSourcePosition: number;
  replayedSourcePosition?: number;
  verified: boolean;
  reason?: OpenEpisodeReplayBlockReason;
}

export interface OpenEpisodeReplayReconciliation {
  bootstrapScale?: number;
  currentOpenPositionCount: number;
  verifiedOpenPositionCount: number;
  blockedOpenPositionCount: number;
  allCurrentOpenPositionsVerified: boolean;
  positions: OpenEpisodeReplayReconciliationPosition[];
}

export interface OpenEpisodeReplayPlan {
  bootstrapScale?: number;
  episodes: OpenEpisodeReplayEpisode[];
  /** All verified episode steps, globally sorted by timestamp. */
  replay: OpenEpisodeReplayStep[];
  /** Compatibility alias for consumers that describe the plan as replay fills. */
  replayFills: OpenEpisodeReplayStep[];
  blocked: OpenEpisodeReplayBlockedCoin[];
  reconciliation: OpenEpisodeReplayReconciliation;
  /** Convenience alias for the reconciliation gate. */
  reconciled: boolean;
}

interface ParsedFill {
  raw: OpenEpisodeSourceFill;
  coin: string;
  start: number;
  /** Position used for ordered replay; may be synthesized inside one atomic millisecond batch. */
  orderedStart: number;
  size: number;
  delta: number;
  after: number;
  price: number;
  time: number;
  fee?: number;
  identity: string;
  synthesizedWithinMillisecond?: boolean;
}

interface ParsedPosition {
  coin: string;
  size: number;
  entryPrice: number;
}

interface CandidateResult {
  episode?: OpenEpisodeReplayEpisode;
  reason?: OpenEpisodeReplayBlockReason;
}

const finite = (value: unknown): number | undefined => {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
};

const isZero = (value: number): boolean => Math.abs(value) <= EPSILON;
const normaliseZero = (value: number): number => isZero(value) ? 0 : value;
const same = (left: number, right: number): boolean => Math.abs(left - right) <= EPSILON;
const sign = (value: number): -1 | 0 | 1 => value > EPSILON ? 1 : value < -EPSILON ? -1 : 0;

/** Keeps the DEX namespace intact; callers must already qualify non-default DEX assets. */
const coinKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toUpperCase();
  return key.length > 0 ? key : undefined;
};

const fillIdentity = (fill: OpenEpisodeSourceFill, coin: string, time: number): string =>
  `${coin}|${time}|${String(fill.tid)}`;

const validIdentifier = (value: unknown): boolean =>
  (typeof value === "string" && value.trim().length > 0) ||
  (typeof value === "number" && Number.isFinite(value));

const parseFill = (raw: OpenEpisodeSourceFill): ParsedFill | undefined => {
  const coin = coinKey(raw.coin);
  const start = finite(raw.startPosition);
  const size = finite(raw.sz);
  const price = finite(raw.px);
  const time = finite(raw.time);
  const fee = raw.fee === undefined ? undefined : finite(raw.fee);
  if (
    !coin || start === undefined || size === undefined || size <= EPSILON ||
    price === undefined || price <= 0 || time === undefined || time < 0 ||
    !Number.isSafeInteger(time) || (raw.side !== "B" && raw.side !== "A") ||
    !validIdentifier(raw.hash) || !validIdentifier(raw.oid) || !validIdentifier(raw.tid) ||
    (raw.fee !== undefined && fee === undefined)
  ) return undefined;
  const delta = raw.side === "B" ? size : -size;
  return {
    raw,
    coin,
    start: normaliseZero(start),
    orderedStart: normaliseZero(start),
    size,
    delta,
    after: normaliseZero(start + delta),
    price,
    time,
    ...(fee === undefined ? {} : { fee }),
    identity: fillIdentity(raw, coin, time),
  };
};

/**
 * Finds the only position-continuous ordering for a same-millisecond group
 * without falling back to response/input order. Large unbranched groups use a
 * bounded deterministic search; only small branching groups may use DFS.
 */
const uniqueOrderWithinMillisecond = (group: ParsedFill[]): ParsedFill[] | undefined => {
  if (group.length <= 1) return group;

  // This is O(n^3): try each possible first fill, then greedily continue only
  // when exactly one unused fill reports the required next position. It handles
  // large API-shuffled chains without factorial search.
  const greedyChains: ParsedFill[][] = [];
  for (let starter = 0; starter < group.length; starter += 1) {
    const used = new Array<boolean>(group.length).fill(false);
    const chain: ParsedFill[] = [];
    let index = starter;
    while (index !== -1) {
      const fill = group[index]!;
      used[index] = true;
      chain.push(fill);
      if (chain.length === group.length) {
        greedyChains.push(chain);
        break;
      }
      const candidates = group.flatMap((candidate, candidateIndex) => (
        !used[candidateIndex] && same(candidate.start, fill.after) ? [candidateIndex] : []
      ));
      index = candidates.length === 1 ? candidates[0]! : -1;
    }
  }
  if (greedyChains.length === 1) return greedyChains[0];

  // A branch may still have exactly one complete path. Resolve that only for
  // small groups; a large branch remains fail-closed.
  if (group.length <= MAX_SAME_MILLISECOND_FILLS) {
    const paths: ParsedFill[][] = [];
    const used = new Array<boolean>(group.length).fill(false);
    const path: ParsedFill[] = [];
    const visit = (expectedStart: number | undefined): void => {
      if (paths.length > 1) return;
      if (path.length === group.length) {
        paths.push([...path]);
        return;
      }
      const candidates = group.flatMap((fill, index) => (
        !used[index] && (expectedStart === undefined || same(fill.start, expectedStart)) ? [index] : []
      ));
      for (const index of candidates) {
        used[index] = true;
        const fill = group[index]!;
        path.push(fill);
        visit(fill.after);
        path.pop();
        used[index] = false;
        if (paths.length > 1) return;
      }
    };
    visit(undefined);
    if (paths.length === 1) return paths[0];
  }

  // Hyperliquid can report one pre-batch inventory value for each unaggregated
  // fill in an atomic batch. We can synthesize its internal chain only when all
  // fills are one-sided and its economics cannot depend on their order.
  const reportedStart = group[0]!.start;
  const oneReportedStart = group.every((fill) => same(fill.start, reportedStart));
  const oneSide = group.every((fill) => fill.raw.side === group[0]!.raw.side);
  if (!oneReportedStart || !oneSide) return undefined;
  const summedDelta = group.reduce((total, fill) => total + fill.delta, 0);
  const finalPosition = normaliseZero(reportedStart + summedDelta);
  const noCrossOrReversal = sign(reportedStart) === 0 || sign(finalPosition) === 0 || sign(reportedStart) === sign(finalPosition);
  const equalExecutionPrice = group.every((fill) => same(fill.price, group[0]!.price));
  if (!noCrossOrReversal && !equalExecutionPrice) return undefined;

  const stableIdentityOrder = [...group].sort((left, right) => (
    left.identity.localeCompare(right.identity) ||
    left.raw.hash.localeCompare(right.raw.hash) ||
    String(left.raw.oid).localeCompare(String(right.raw.oid))
  ));
  let orderedStart = reportedStart;
  return stableIdentityOrder.map((fill) => {
    const after = normaliseZero(orderedStart + fill.delta);
    const synthesized = {
      ...fill,
      orderedStart,
      after,
      synthesizedWithinMillisecond: true,
    };
    orderedStart = after;
    return synthesized;
  });
};

const orderFills = (fills: ParsedFill[]): { ordered?: ParsedFill[]; ambiguous: boolean } => {
  const groups = new Map<number, ParsedFill[]>();
  for (const fill of fills) {
    const group = groups.get(fill.time) ?? [];
    group.push(fill);
    groups.set(fill.time, group);
  }
  const ordered: ParsedFill[] = [];
  for (const time of [...groups.keys()].sort((left, right) => left - right)) {
    const group = uniqueOrderWithinMillisecond(groups.get(time)!);
    if (!group) return { ambiguous: true };
    ordered.push(...group);
  }
  return { ordered, ambiguous: false };
};

const stepFor = (
  fill: ParsedFill,
  sequence: number,
  kind: OpenEpisodeReplayStep["kind"],
  episodeBefore: number,
  episodeAfter: number,
  replayedSourceDelta: number,
  bootstrapScale: number,
): OpenEpisodeReplayStep => {
  const portion = Math.abs(replayedSourceDelta) / fill.size;
  const sourceFee = fill.fee === undefined ? undefined : fill.fee * portion;
  return {
    id: `${fill.identity}|${sequence}`,
    coin: fill.coin,
    time: fill.time,
    sequence,
    kind,
    fillStartPosition: fill.start,
    sourcePositionBefore: episodeBefore,
    sourcePositionAfter: episodeAfter,
    fullFillSize: fill.size,
    replayedSourceDelta,
    replayedFollowerDelta: replayedSourceDelta * bootstrapScale,
    price: fill.price,
    ...(sourceFee === undefined ? {} : { sourceFee, replayedFee: sourceFee * bootstrapScale }),
    ...(fill.synthesizedWithinMillisecond ? { synthesizedWithinMillisecond: true } : {}),
    fill: {
      coin: fill.coin,
      startPosition: String(fill.orderedStart),
      side: fill.raw.side,
      sz: String(fill.size),
      px: String(fill.price),
      time: fill.time,
      hash: fill.raw.hash,
      oid: fill.raw.oid,
      tid: fill.raw.tid,
      fee: String(fill.fee ?? 0),
    },
    hash: fill.raw.hash,
    oid: fill.raw.oid,
    tid: fill.raw.tid,
  };
};

const replayFromCandidate = (
  fills: ParsedFill[],
  candidateIndex: number,
  boundary: OpenEpisodeReplayEpisode["boundary"],
  snapshot: ParsedPosition,
  bootstrapScale: number,
): CandidateResult => {
  const candidate = fills[candidateIndex]!;
  let current = candidate.after;
  let averageEntryPrice = candidate.price;
  if (isZero(current)) return { reason: "MISSING_FLAT_BOUNDARY" };
  const steps: OpenEpisodeReplayStep[] = [];
  const initialDelta = boundary === "REVERSAL" ? current : candidate.delta;
  steps.push(stepFor(candidate, 0, "ENTRY", 0, current, initialDelta, bootstrapScale));

  for (let index = candidateIndex + 1; index < fills.length; index += 1) {
    const fill = fills[index]!;
    if (!same(fill.orderedStart, current)) return { reason: "POSITION_CONTINUITY_MISMATCH" };
    const next = fill.after;
    if (isZero(next) || sign(next) !== sign(current)) return { reason: "EPISODE_CLOSED_BEFORE_SNAPSHOT" };
    const kind: OpenEpisodeReplayStep["kind"] = sign(fill.delta) === sign(current) ? "ADD" : "PARTIAL_EXIT";
    if (kind === "ADD") {
      averageEntryPrice = (Math.abs(current) * averageEntryPrice + Math.abs(fill.delta) * fill.price) / Math.abs(next);
    }
    steps.push(stepFor(fill, steps.length, kind, current, next, fill.delta, bootstrapScale));
    current = next;
  }
  if (!same(current, snapshot.size)) return { reason: "FINAL_POSITION_MISMATCH" };
  const entryTolerance = Math.max(EPSILON, Math.max(Math.abs(averageEntryPrice), Math.abs(snapshot.entryPrice)) * OPEN_EPISODE_ENTRY_PRICE_RELATIVE_TOLERANCE);
  if (Math.abs(averageEntryPrice - snapshot.entryPrice) > entryTolerance) return { reason: "AVERAGE_ENTRY_PRICE_MISMATCH" };
  return {
    episode: {
      id: `${snapshot.coin}|${candidate.identity}|${boundary}`,
      coin: snapshot.coin,
      direction: current > 0 ? "LONG" : "SHORT",
      boundary,
      sourceEntryPrice: snapshot.entryPrice,
      replayedAverageEntryPrice: averageEntryPrice,
      entryTime: candidate.time,
      sourcePosition: current,
      followerPosition: current * bootstrapScale,
      fills: steps,
    },
  };
};

const blockDetail: Record<OpenEpisodeReplayBlockReason, string> = {
  INVALID_BOOTSTRAP_SCALE: "Follower allocation and source total equity must be finite positive values.",
  INVALID_SOURCE_POSITION: "Current source position has an invalid coin, size, or entry price.",
  DUPLICATE_SOURCE_POSITION: "Current snapshot contains more than one position for this qualified coin key.",
  INVALID_FILL: "A fill required for this current coin is missing a valid unaggregated identity or numeric field.",
  CONFLICTING_FILL_IDENTITY: "The same fill identity was supplied with conflicting values.",
  SAME_MILLISECOND_ORDER_AMBIGUOUS: "Same-millisecond fills do not have one position-continuous order.",
  POSITION_CONTINUITY_MISMATCH: "A fill startPosition does not continue from the preceding replay position.",
  MISSING_FLAT_BOUNDARY: "No retained flat-to-entry or zero-crossing reversal boundary exists for this open position.",
  EPISODE_CLOSED_BEFORE_SNAPSHOT: "The candidate episode reached or crossed flat before the current source snapshot.",
  AVERAGE_ENTRY_PRICE_MISMATCH: "The replayed average entry price differs materially from the current source snapshot entry price.",
  FINAL_POSITION_MISMATCH: "The replayed source position does not equal the current source snapshot size.",
};

/**
 * Produces plans only for positions that can be reconstructed exactly from the
 * provided fills. It intentionally has no network, clock, persistence, or
 * execution side effects.
 */
export const planOpenEpisodeReplay = (input: OpenEpisodeReplayInput): OpenEpisodeReplayPlan => {
  const blocked = new Map<string, OpenEpisodeReplayBlockedCoin>();
  const reconciliation = new Map<string, OpenEpisodeReplayReconciliationPosition>();
  const addBlocked = (coin: string, reason: OpenEpisodeReplayBlockReason, detail = blockDetail[reason]): void => {
    if (!blocked.has(coin)) blocked.set(coin, { coin, reason, detail });
  };

  const positions = new Map<string, ParsedPosition>();
  for (const raw of input.sourcePositions) {
    const coin = coinKey(raw.coin) ?? "UNKNOWN";
    const size = finite(raw.szi);
    const entryPrice = finite(raw.entryPriceUsd ?? raw.entryPx);
    if (!coinKey(raw.coin) || size === undefined || entryPrice === undefined || entryPrice <= 0) {
      addBlocked(coin, "INVALID_SOURCE_POSITION");
      continue;
    }
    if (blocked.has(coin)) continue;
    if (isZero(size)) continue;
    if (positions.has(coin)) {
      addBlocked(coin, "DUPLICATE_SOURCE_POSITION");
      positions.delete(coin);
      continue;
    }
    positions.set(coin, { coin, size: normaliseZero(size), entryPrice });
  }

  const followerAllocation = finite(input.followerAllocationUsd);
  const sourceEquity = finite(input.sourceTotalEquityUsd);
  const bootstrapScale = followerAllocation !== undefined && followerAllocation > 0 && sourceEquity !== undefined && sourceEquity > 0
    ? followerAllocation / sourceEquity
    : undefined;
  if (bootstrapScale === undefined || !Number.isFinite(bootstrapScale) || bootstrapScale <= 0) {
    for (const position of positions.values()) addBlocked(position.coin, "INVALID_BOOTSTRAP_SCALE");
  }

  const fillsByCoin = new Map<string, ParsedFill[]>();
  const fillFingerprints = new Map<string, string>();
  for (const raw of input.fills) {
    const rawCoin = coinKey(raw.coin);
    if (!rawCoin || !positions.has(rawCoin)) continue;
    const fill = parseFill(raw);
    if (!fill) {
      addBlocked(rawCoin, "INVALID_FILL");
      continue;
    }
    const fingerprint = [fill.start, fill.size, fill.price, fill.raw.side, fill.raw.hash, fill.raw.oid, fill.fee ?? ""].join("|");
    const priorFingerprint = fillFingerprints.get(fill.identity);
    if (priorFingerprint !== undefined) {
      if (priorFingerprint !== fingerprint) addBlocked(fill.coin, "CONFLICTING_FILL_IDENTITY");
      continue;
    }
    fillFingerprints.set(fill.identity, fingerprint);
    const fills = fillsByCoin.get(fill.coin) ?? [];
    fills.push(fill);
    fillsByCoin.set(fill.coin, fills);
  }

  const episodes: OpenEpisodeReplayEpisode[] = [];
  for (const position of positions.values()) {
    if (blocked.has(position.coin)) {
      reconciliation.set(position.coin, { coin: position.coin, snapshotSourcePosition: position.size, verified: false, reason: blocked.get(position.coin)!.reason });
      continue;
    }
    if (bootstrapScale === undefined) {
      addBlocked(position.coin, "INVALID_BOOTSTRAP_SCALE");
      reconciliation.set(position.coin, { coin: position.coin, snapshotSourcePosition: position.size, verified: false, reason: "INVALID_BOOTSTRAP_SCALE" });
      continue;
    }
    const { ordered, ambiguous } = orderFills(fillsByCoin.get(position.coin) ?? []);
    if (ambiguous) {
      addBlocked(position.coin, "SAME_MILLISECOND_ORDER_AMBIGUOUS");
      reconciliation.set(position.coin, { coin: position.coin, snapshotSourcePosition: position.size, verified: false, reason: "SAME_MILLISECOND_ORDER_AMBIGUOUS" });
      continue;
    }
    const candidates: Array<{ index: number; boundary: OpenEpisodeReplayEpisode["boundary"] }> = [];
    for (const [index, fill] of (ordered ?? []).entries()) {
      if (isZero(fill.orderedStart) && !isZero(fill.after)) candidates.push({ index, boundary: "FLAT" });
      else if (!isZero(fill.orderedStart) && !isZero(fill.after) && sign(fill.orderedStart) !== sign(fill.after)) candidates.push({ index, boundary: "REVERSAL" });
    }
    if (candidates.length === 0) {
      addBlocked(position.coin, "MISSING_FLAT_BOUNDARY");
      reconciliation.set(position.coin, { coin: position.coin, snapshotSourcePosition: position.size, verified: false, reason: "MISSING_FLAT_BOUNDARY" });
      continue;
    }
    let selected: OpenEpisodeReplayEpisode | undefined;
    let lastReason: OpenEpisodeReplayBlockReason = "MISSING_FLAT_BOUNDARY";
    for (const candidate of [...candidates].reverse()) {
      const result = replayFromCandidate(ordered ?? [], candidate.index, candidate.boundary, position, bootstrapScale);
      if (result.episode) {
        selected = result.episode;
        break;
      }
      if (result.reason) lastReason = result.reason;
    }
    if (!selected) {
      addBlocked(position.coin, lastReason);
      reconciliation.set(position.coin, { coin: position.coin, snapshotSourcePosition: position.size, verified: false, reason: lastReason });
      continue;
    }
    episodes.push(selected);
    reconciliation.set(position.coin, {
      coin: position.coin,
      snapshotSourcePosition: position.size,
      replayedSourcePosition: selected.sourcePosition,
      verified: true,
    });
  }

  const replay = episodes
    .flatMap((episode) => episode.fills)
    .sort((left, right) => left.time - right.time || left.coin.localeCompare(right.coin) || left.sequence - right.sequence);
  const positionsSummary = [...reconciliation.values()].sort((left, right) => left.coin.localeCompare(right.coin));
  const currentOpenPositionCount = positions.size;
  return {
    ...(bootstrapScale === undefined ? {} : { bootstrapScale }),
    episodes: episodes.sort((left, right) => left.coin.localeCompare(right.coin)),
    replay,
    replayFills: replay,
    blocked: [...blocked.values()].sort((left, right) => left.coin.localeCompare(right.coin)),
    reconciliation: {
      ...(bootstrapScale === undefined ? {} : { bootstrapScale }),
      currentOpenPositionCount,
      verifiedOpenPositionCount: episodes.length,
      blockedOpenPositionCount: positionsSummary.filter((position) => !position.verified).length,
      allCurrentOpenPositionsVerified: currentOpenPositionCount === episodes.length && blocked.size === 0,
      positions: positionsSummary,
    },
    reconciled: currentOpenPositionCount === episodes.length && blocked.size === 0,
  };
};

/** Public bootstrap contract used by the realtime runner. */
export const buildOpenEpisodeReplay = planOpenEpisodeReplay;
