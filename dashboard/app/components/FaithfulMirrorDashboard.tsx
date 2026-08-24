"use client";

import { useEffect, useRef } from "react";

import type {
  FaithfulMirrorEvent,
  FaithfulMirrorPair,
  FaithfulMirrorSnapshot,
  FaithfulMirrorStatus,
} from "../hooks/use-faithful-mirror-status";

type UnknownRecord = Record<string, unknown>;
type MirrorViewMode = "PAPER" | "LIVE";

const COHORT_BY_SOURCE: Record<string, { rank: number; twr: number }> = {
  "0x40f20b734d7d25ba0b6219e921382fa992a56a9e": { rank: 1, twr: 32972.79 },
  "0x9f5777bb808871052c2c5fc13d37d05e67fbc70e": { rank: 2, twr: 1149.29 },
  "0x7647fc553bc8a03df9affbdc656ae159d894a40c": { rank: 3, twr: 1038.35 },
  "0x744a26a3e5a56efb7d95119752a63183c236bbd0": { rank: 4, twr: 915.14 },
  "0xc16c69d13583ced94245f79afb8751a1883bf2c6": { rank: 5, twr: 772.05 },
};

const numeric = (value: unknown): number | null => {
  const next = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(next) ? next : null;
};

const valueAt = (value: UnknownRecord, keys: string[]): unknown => {
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return null;
};

const numberAt = (value: UnknownRecord, keys: string[]): number | null => numeric(valueAt(value, keys));

const textAt = (value: UnknownRecord, keys: string[], fallback = "—"): string => {
  const candidate = valueAt(value, keys);
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : candidate == null ? fallback : String(candidate);
};

const formatUsd = (value: number | null, digits = 0) => value == null
  ? "—"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(value);

const formatPercent = (value: number | null, digits = 1) => value == null
  ? "—"
  : `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value)}%`;

const formatNumber = (value: number | null, digits = 2) => value == null
  ? "—"
  : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);

const formatTime = (time: number | null) => time == null
  ? "수신 대기"
  : new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(time));

const shortAddress = (address: string | null) => address && address.length > 14
  ? `${address.slice(0, 8)}…${address.slice(-6)}`
  : address ?? "주소 대기";

const knownTotal = (values: Array<number | null>) => {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};

type ExposureRow = { coin: string; notionalUsd: number; signedNotionalUsd: number };

const positionNotional = (position: UnknownRecord): number | null => {
  const direct = numberAt(position, ["positionValueUsd", "positionValue", "notionalUsd", "notional"]);
  if (direct != null) return Math.abs(direct);
  const size = numberAt(position, ["signedSize", "szi", "size", "positionSize"]);
  const price = numberAt(position, ["markPriceUsd", "markPx", "markPrice", "price", "entryPriceUsd", "entryPx"]);
  return size != null && price != null ? Math.abs(size * price) : null;
};

const positionSignedNotional = (position: UnknownRecord): number | null => {
  const direct = numberAt(position, ["positionValueUsd", "positionValue", "notionalUsd", "notional"]);
  const size = numberAt(position, ["signedSize", "szi", "size", "positionSize"]);
  // Snapshots can expose positive positionValue for both long and short. The
  // signed position size is authoritative for net exposure direction.
  if (direct != null) return size != null && Math.abs(size) > 1e-12 ? Math.sign(size) * Math.abs(direct) : direct;
  const price = numberAt(position, ["markPriceUsd", "markPx", "markPrice", "price", "entryPriceUsd", "entryPx"]);
  return size != null && price != null ? size * price : null;
};

const exposureRows = (positions: UnknownRecord[]): ExposureRow[] => {
  const byCoin = new Map<string, ExposureRow>();
  for (const position of positions) {
    const notionalUsd = positionNotional(position);
    if (notionalUsd == null) continue;
    const coin = textAt(position, ["coin", "asset"], "UNKNOWN");
    const prior = byCoin.get(coin) ?? { coin, notionalUsd: 0, signedNotionalUsd: 0 };
    byCoin.set(coin, {
      coin,
      notionalUsd: prior.notionalUsd + notionalUsd,
      signedNotionalUsd: prior.signedNotionalUsd + (positionSignedNotional(position) ?? 0),
    });
  }
  return [...byCoin.values()].sort((left, right) => right.notionalUsd - left.notionalUsd);
};

const grossNotional = (positions: UnknownRecord[]) => knownTotal(positions.map(positionNotional));
const netNotional = (positions: UnknownRecord[]) => knownTotal(positions.map(positionSignedNotional));
const percentOf = (value: number | null, base: number | null) => value != null && base != null && Math.abs(base) > 1e-12 ? value / base * 100 : null;
const ratioOf = (value: number | null, base: number | null) => value != null && base != null && Math.abs(base) > 1e-12 ? value / base : null;
const isOpenOrder = (order: UnknownRecord) => !["CANCELED", "CANCELLED", "FILLED", "REJECTED", "TERMINAL", "TERMINAL_OR_MISSING"].includes(textAt(order, ["status"], "OPEN").toUpperCase());
const debtItems = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.filter((item): item is UnknownRecord => Boolean(item) && typeof item === "object") : [];
const debtCount = (value: unknown): number | null => Array.isArray(value) ? value.length : numeric(value);

const equityLatencyMs = (time: number | null, now: number) => time == null ? null : Math.max(0, now - time);

const pairStatus = (pair: FaithfulMirrorPair) => pair.killed
  ? "KILLED"
  : pair.blocked
    ? "BLOCKED"
    : pair.state || "UNKNOWN";

const statusTone = (state: string) => {
  const normalized = state.toUpperCase();
  if (normalized === "RUNNING" || normalized === "READY") return "good";
  if (normalized === "KILLED" || normalized === "BLOCKED" || normalized === "ERROR") return "bad";
  if (normalized === "STOPPED" || normalized === "UNKNOWN") return "muted";
  return "warn";
};

const positionsFor = (pair: FaithfulMirrorPair, role: "source" | "target") => pair[role].positions.slice(0, 3);
const ordersFor = (pair: FaithfulMirrorPair, role: "source" | "target") => pair[role].orders.filter(isOpenOrder).slice(0, 2);

export const summarizeFaithfulMirrorPair = (pair: FaithfulMirrorPair) => {
  const sourceGross = grossNotional(pair.source.positions);
  const followerGross = grossNotional(pair.target.positions);
  const positionDebtValue = valueAt(pair.trackingDebt, ["positions", "positionCount", "positionDebt"]);
  const orderDebtValue = valueAt(pair.trackingDebt, ["orders", "orderCount", "orderDebt"]);
  return {
    sourceGross,
    sourceNet: netNotional(pair.source.positions),
    sourceEffectiveLeverage: ratioOf(sourceGross, pair.source.equityUsd),
    followerGross,
    followerToSourceGrossPct: percentOf(followerGross, sourceGross),
    sourceOpenOrderCount: pair.source.orders.filter(isOpenOrder).length,
    followerOpenOrderCount: pair.target.orders.filter(isOpenOrder).length,
    positionDebtCount: debtCount(positionDebtValue),
    orderDebtCount: debtCount(orderDebtValue),
    positionDebtNotional: knownTotal(debtItems(positionDebtValue).map(positionNotional)),
  };
};

function AccountColumn({ label, account, pair, accountKind, startingCapitalUsd }: {
  label: string;
  account: FaithfulMirrorPair["source"];
  pair: FaithfulMirrorPair;
  accountKind: "source" | "target";
  startingCapitalUsd: number | null;
}) {
  const pnl = numberAt(pair.metrics, accountKind === "source"
    ? ["sourcePnlUsd", "sourcePnl", "sourceEquityPnlUsd"]
    : ["targetPnlUsd", "followerPnlUsd", "targetPnl", "followerPnl"]);
  const positions = positionsFor(pair, accountKind);
  const orders = ordersFor(pair, accountKind);
  const gross = grossNotional(account.positions);
  const net = netNotional(account.positions);
  const leverage = ratioOf(gross, account.equityUsd);
  const returnPct = percentOf(pnl, startingCapitalUsd);
  const marginUsed = numberAt(account.facts, ["marginUsedUsd", "marginUsed", "totalMarginUsedUsd"]);
  const maintenance = numberAt(account.facts, ["maintenanceMarginUsd", "maintenanceMargin", "maintenanceRequirementUsd"]);
  const withdrawable = numberAt(account.facts, ["withdrawableUsd", "withdrawable", "availableToWithdrawUsd"]);
  const approximateLiquidation = account.facts.approximateLiquidation === true || account.facts.approxLiquidation === true;
  return (
    <section className="fmv2-account-column" aria-label={`${pair.pairId} ${label}`}>
      <div className="fmv2-account-column__heading">
        <span>{label}</span>
        <time>{formatTime(account.receivedAt)}</time>
      </div>
      <strong>{formatUsd(account.equityUsd, 0)}</strong>
      <span className={pnl != null && pnl < 0 ? "fmv2-number is-negative" : "fmv2-number is-positive"}>
        PnL {formatUsd(pnl, 0)}
      </span>
      <div className="fmv2-capital-line">
        <span>시작 {formatUsd(startingCapitalUsd, 0)}</span>
        <span className={returnPct != null && returnPct < 0 ? "is-negative" : "is-positive"}>수익률 {formatPercent(returnPct, 1)}</span>
      </div>
      <div className="fmv2-inventory">
        <span>포지션 {account.positions.length}</span>
        <span>주문 {account.orders.filter(isOpenOrder).length}</span>
      </div>
      {positions.length ? (
        <ul className="fmv2-mini-list" aria-label={`${label} 포지션`}>
          {positions.map((position, index) => (
            <li key={`${textAt(position, ["coin", "asset"], "asset")}-${index}`}>
              <strong>{textAt(position, ["coin", "asset"], "ASSET")}</strong>
              <span>{formatNumber(numberAt(position, ["signedSize", "szi", "size", "positionSize"]), 4)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="fmv2-empty-line">관측 포지션 없음</p>}
      {orders.length ? (
        <ul className="fmv2-mini-list fmv2-mini-list--orders" aria-label={`${label} 미체결 주문`}>
          {orders.map((order, index) => (
            <li key={`${textAt(order, ["id", "oid", "clientOrderId"], "order")}-${index}`}>
              <strong>{textAt(order, ["coin", "asset"], "ORDER")}</strong>
              <span>{textAt(order, ["side", "direction"], "OPEN").toUpperCase()}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="fmv2-account-facts" aria-label={`${label} 노출 및 마진 정보`}>
        <span><small>Gross / Net</small><strong>{formatUsd(gross, 0)} / {formatUsd(net, 0)}</strong></span>
        <span><small>유효 레버리지</small><strong>{leverage == null ? "—" : `${formatNumber(leverage, 2)}x`}</strong></span>
        <span><small>사용 / 유지 증거금</small><strong>{formatUsd(marginUsed, 0)} / {formatUsd(maintenance, 0)}</strong></span>
        <span><small>출금 가능</small><strong>{formatUsd(withdrawable, 0)}</strong></span>
        {approximateLiquidation ? <em>APPROX. LIQUIDATION</em> : null}
      </div>
    </section>
  );
}

function ExposureComparison({ pair }: { pair: FaithfulMirrorPair }) {
  const source = exposureRows(pair.source.positions);
  const follower = exposureRows(pair.target.positions);
  const sourceByCoin = new Map(source.map((row) => [row.coin, row]));
  const followerByCoin = new Map(follower.map((row) => [row.coin, row]));
  const rawByCoin = valueAt(pair.metrics, ["byCoin", "coinMetrics", "reconciliationByCoin"]);
  const byCoin = rawByCoin && typeof rawByCoin === "object" && !Array.isArray(rawByCoin) ? rawByCoin as UnknownRecord : {};
  const coins = [...new Set([...sourceByCoin.keys(), ...followerByCoin.keys()])]
    .sort((left, right) => Math.max(sourceByCoin.get(right)?.notionalUsd ?? 0, followerByCoin.get(right)?.notionalUsd ?? 0) - Math.max(sourceByCoin.get(left)?.notionalUsd ?? 0, followerByCoin.get(left)?.notionalUsd ?? 0))
    .slice(0, 5);
  if (!coins.length) return <p className="fmv2-exposure-empty">코인별 노출 비교는 포지션 notional 관측 후 표시됩니다.</p>;
  return (
    <section className="fmv2-exposure-table" aria-label={`${pair.pairId} 코인별 복제 비교`}>
      <div className="fmv2-exposure-table__head"><span>COIN</span><span>SOURCE</span><span>FOLLOWER</span><span>FOLLOW / SOURCE</span><span>REPL. ERROR</span></div>
      {coins.map((coin) => {
        const sourceRow = sourceByCoin.get(coin);
        const followerRow = followerByCoin.get(coin);
        const metric = byCoin[coin] && typeof byCoin[coin] === "object" && !Array.isArray(byCoin[coin]) ? byCoin[coin] as UnknownRecord : {};
        const serverError = numberAt(metric, ["replicationErrorBps", "residualBps", "errorBps"]);
        return (
          <div className="fmv2-exposure-table__row" key={coin}>
            <strong>{coin}</strong>
            <span>{formatUsd(sourceRow?.notionalUsd ?? null, 0)}</span>
            <span>{formatUsd(followerRow?.notionalUsd ?? null, 0)}</span>
            <span>{formatPercent(percentOf(followerRow?.notionalUsd ?? null, sourceRow?.notionalUsd ?? null), 1)}</span>
            <span>{serverError == null ? "—" : `${formatNumber(serverError, 1)} bps`}</span>
          </div>
        );
      })}
      <p>비율은 관측 notional의 follower/source 입니다. 복제 오차는 서버가 coin 단위 지표를 제공한 경우에만 표시합니다.</p>
    </section>
  );
}

function PairCard({ pair }: { pair: FaithfulMirrorPair }) {
  const summary = summarizeFaithfulMirrorPair(pair);
  const cohort = pair.sourceAddress ? COHORT_BY_SOURCE[pair.sourceAddress.toLowerCase()] : undefined;
  const latency = numberAt(pair.metrics, ["latencyMs", "reconciliationLatencyMs", "lastLatencyMs"]);
  const residualBps = numberAt(pair.metrics, ["residualBps", "reconciliationResidualBps", "positionResidualBps"]);
  const coverage = numberAt(pair.metrics, ["coveragePct", "coveragePercent", "dataCoveragePct"]);
  const positionDebt = summary.positionDebtCount;
  const orderDebt = summary.orderDebtCount;
  const positionDebtNotional = summary.positionDebtNotional;
  const sourcePnl = numberAt(pair.metrics, ["sourcePnlUsd", "sourcePnl", "sourceEquityPnlUsd"]);
  const followerPnl = numberAt(pair.metrics, ["targetPnlUsd", "followerPnlUsd", "targetPnl", "followerPnl"]);
  const sourceStartingCapitalUsd = numberAt(pair.metrics, ["sourceStartingCapitalUsd", "sourceStartCapitalUsd", "sourceInitialEquityUsd", "sourceInitialCapitalUsd"])
    ?? numberAt(pair.source.facts, ["startingCapitalUsd", "startCapitalUsd", "initialEquityUsd", "initialCapitalUsd"]);
  const followerStartingCapitalUsd = numberAt(pair.metrics, ["targetStartingCapitalUsd", "followerStartingCapitalUsd", "targetStartCapitalUsd", "targetInitialEquityUsd", "initialCapitalUsd"])
    ?? numberAt(pair.target.facts, ["startingCapitalUsd", "startCapitalUsd", "initialEquityUsd", "initialCapitalUsd"]);
  const sourceGross = summary.sourceGross;
  const followerGross = summary.followerGross;
  const topSource = exposureRows(pair.source.positions)[0] ?? null;
  const concentration = topSource ? percentOf(topSource.notionalUsd, sourceGross) : null;
  const mirrorCoverage = numberAt(pair.metrics, ["orderMirrorCoveragePct", "mirrorCoveragePct", "openOrderCoveragePct"]);
  const openTargetOrders = pair.target.orders.filter(isOpenOrder);
  const reduceOnly = openTargetOrders.filter((order) => order.reduceOnly === true).length;
  const tpSl = openTargetOrders.filter((order) => {
    const kind = textAt(order, ["tpsl", "triggerType", "orderType"], "").toUpperCase();
    return kind.includes("TP") || kind.includes("SL") || kind.includes("TRIGGER");
  }).length;
  const riskReason = pair.killReason ?? pair.lastError ?? textAt(pair.metrics, ["riskGate", "gateReason", "reconciliationState"], "리스크 게이트 관측 대기");
  const state = pairStatus(pair);
  return (
    <article className={`fmv2-whale-card fmv2-whale-card--${statusTone(state)}`}>
      <header className="fmv2-whale-card__header">
        <div>
          <span className="eyebrow">{cohort ? `COHORT RANK ${cohort.rank}` : "SOURCE / FOLLOWER"}</span>
          <h2>{pair.pairId}</h2>
          {cohort ? <p>고정 스냅샷 TWR {formatPercent(cohort.twr, 2)}</p> : null}
        </div>
        <span className={`fmv2-state fmv2-state--${statusTone(state)}`}>{state}</span>
      </header>
      <div className="fmv2-address-row">
        <span>소스 {shortAddress(pair.sourceAddress)}</span>
        <span>팔로워 {pair.targetAccountLabel ?? "서버 마스킹 라벨 대기"}{pair.targetAddressDisplay ? ` · ${pair.targetAddressDisplay}` : ""}</span>
      </div>
      <div className="fmv2-account-grid">
        <AccountColumn label="SOURCE" account={pair.source} pair={pair} accountKind="source" startingCapitalUsd={sourceStartingCapitalUsd} />
        <AccountColumn label="FOLLOWER" account={pair.target} pair={pair} accountKind="target" startingCapitalUsd={followerStartingCapitalUsd} />
      </div>
      <div className="fmv2-mirror-summary" aria-label={`${pair.pairId} 미러 복제 상태`}>
        <span><small>Follower / Source Gross</small><strong>{formatPercent(percentOf(followerGross, sourceGross), 1)}</strong></span>
        <span><small>Top source concentration</small><strong>{topSource ? `${topSource.coin} · ${formatPercent(concentration, 1)}` : "—"}</strong></span>
        <span><small>Order mirror coverage</small><strong>{formatPercent(mirrorCoverage, 0)}</strong></span>
        <span><small>RO / TP·SL</small><strong>{reduceOnly} / {tpSl}</strong></span>
        <span><small>Source / follower PnL</small><strong>{formatUsd(sourcePnl, 0)} / {formatUsd(followerPnl, 0)}</strong></span>
        <span><small>Position debt notional</small><strong>{formatUsd(positionDebtNotional, 0)}</strong></span>
      </div>
      <ExposureComparison pair={pair} />
      <div className="fmv2-reconciliation-grid" aria-label={`${pair.pairId} 리스크 및 조정 상태`}>
        <span><small>지연</small><strong>{latency == null ? "—" : `${formatNumber(latency, 0)}ms`}</strong></span>
        <span><small>잔차</small><strong>{residualBps == null ? "—" : `${formatNumber(residualBps, 1)} bps`}</strong></span>
        <span><small>커버리지</small><strong>{coverage == null ? "—" : `${formatPercent(coverage, 0)}`}</strong></span>
        <span><small>추적 부채</small><strong>{positionDebt == null && orderDebt == null ? "—" : `${formatNumber(positionDebt, 0)}P / ${formatNumber(orderDebt, 0)}O`}</strong></span>
      </div>
      <p className={`fmv2-risk-line fmv2-risk-line--${statusTone(state)}`}>
        <span>RISK GATE</span>{riskReason}
      </p>
    </article>
  );
}

function EventTimeline({ events }: { events: FaithfulMirrorEvent[] }) {
  const visible = [...events]
    .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
    .slice(0, 16);
  return (
    <section className="fmv2-timeline" aria-label="Faithful Mirror 이벤트 타임라인">
      <div className="fmv2-section-heading">
        <div><span className="eyebrow">READ-ONLY EVENT STREAM</span><h2>이벤트 타임라인</h2></div>
        <span>{events.length}건 수신</span>
      </div>
      <div className="fmv2-timeline__body">
        {!visible.length ? <p className="fmv2-empty-state">아직 수신된 이벤트가 없습니다. 로컬 서비스 연결 상태를 계속 확인합니다.</p> : null}
        {visible.map((event, index) => (
          <article className="fmv2-event" key={`${event.at ?? "unknown"}-${event.type}-${event.pairId ?? "service"}-${index}`}>
            <time>{formatTime(event.at)}</time>
            <span className={`fmv2-event__type fmv2-event__type--${statusTone(event.type.includes("KILL") || event.type.includes("ERROR") ? "KILLED" : event.type.includes("BOOTSTRAP") ? "RUNNING" : "PENDING")}`}>{event.type}</span>
            <div>
              <strong>{[event.pairId, event.coin, event.side].filter(Boolean).join(" · ") || "서비스"}</strong>
              <p>{event.message ?? textAt(event.details, ["reason", "message", "state"], "세부 메시지 대기")}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function EventFunnel({ events }: { events: FaithfulMirrorEvent[] }) {
  const count = (matcher: RegExp) => events.filter((event) => matcher.test(event.type)).length;
  const steps = [
    ["Source fills", /SOURCE_FILL/],
    ["Shadow create / modify", /SHADOW.*(CREATE|MODIFY)|ORDER.*(CREATE|MODIFY|UPSERT)/],
    ["Shadow cancel", /SHADOW.*CANCEL|ORDER.*CANCEL/],
    ["Immediate catch-up", /CATCH.?UP|IMMEDIATE.*RECONCILE/],
    ["250ms verification", /VERIFY|VERIFICATION/],
    ["1s terminal check", /TERMINAL|RESIDUAL/],
    ["Residual kills", /PAIR_KILLED|KILL/],
    ["Errors", /ERROR|FAILED|BLOCKED/],
  ] as const;
  return (
    <section className="fmv2-funnel" aria-label="수신 이벤트 처리 퍼널">
      <div className="fmv2-section-heading">
        <div><span className="eyebrow">BOUNDED EVENT COUNTERS</span><h2>감시 이벤트 퍼널</h2></div>
        <span>현재 수신 버퍼 기준</span>
      </div>
      <div className="fmv2-funnel__grid">
        {steps.map(([label, matcher]) => <div key={label}><span>{label}</span><strong>{count(matcher)}</strong></div>)}
      </div>
      <p>전체 누적치가 아닌 현재 read-only 이벤트 버퍼의 분류 수입니다. 이벤트가 축약되면 값도 함께 축약됩니다.</p>
    </section>
  );
}

function EquitySparkline({ samples }: { samples: FaithfulMirrorStatus["equitySamples"] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(bounds.width * ratio));
      canvas.height = Math.max(1, Math.floor(bounds.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, bounds.width, bounds.height);
      const usable = samples.filter((sample) => sample.sourceEquityUsd != null || sample.followerEquityUsd != null);
      const values = usable.flatMap((sample) => [sample.sourceEquityUsd, sample.followerEquityUsd].filter((value): value is number => value != null));
      if (usable.length < 2 || values.length < 2) return;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = Math.max(max - min, Math.abs(max) * 0.002, 1);
      const pad = 10;
      const pointFor = (value: number | null, index: number) => value == null ? null : {
        x: pad + index / Math.max(usable.length - 1, 1) * Math.max(1, bounds.width - pad * 2),
        y: pad + (1 - (value - min) / range) * Math.max(1, bounds.height - pad * 2),
      };
      const trace = (key: "sourceEquityUsd" | "followerEquityUsd", color: string) => {
        context.beginPath();
        let started = false;
        usable.forEach((sample, index) => {
          const point = pointFor(sample[key], index);
          if (!point) return;
          if (!started) { context.moveTo(point.x, point.y); started = true; }
          else context.lineTo(point.x, point.y);
        });
        if (started) { context.strokeStyle = color; context.lineWidth = 1.8; context.lineJoin = "round"; context.stroke(); }
      };
      trace("sourceEquityUsd", "#b5ff5c");
      trace("followerEquityUsd", "#66a8ff");
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [samples]);
  return (
    <section className="fmv2-equity-panel" aria-label="세션 내 Equity 비교 곡선">
      <div className="fmv2-section-heading">
        <div><span className="eyebrow">SESSION-LOCAL 1S SAMPLES</span><h2>Source vs follower equity</h2></div>
        <span><i className="fmv2-line-key is-source" /> Source <i className="fmv2-line-key is-follower" /> Follower</span>
      </div>
      <canvas ref={canvasRef} className="fmv2-equity-canvas" aria-label="세션 내 source와 follower equity 비교 그래프" />
      <p>{samples.length < 2 ? "두 개 이상의 로컬 1초 샘플이 수신되면 비교 곡선이 표시됩니다." : `이 브라우저 탭에서 최근 ${samples.length}개 샘플만 보관합니다. 새로고침하면 초기화됩니다.`}</p>
    </section>
  );
}

function OperationalNotes({ mode, snapshot, lastCheckedAt }: { mode: MirrorViewMode; snapshot: FaithfulMirrorSnapshot | null; lastCheckedAt: number | null }) {
  const service = snapshot?.service;
  const referenceAt = lastCheckedAt ?? snapshot?.observedAt ?? null;
  const sourceAge = referenceAt == null ? [] : snapshot?.pairs.map((pair) => equityLatencyMs(pair.source.receivedAt, referenceAt)).filter((value): value is number => value != null) ?? [];
  const targetAge = referenceAt == null ? [] : snapshot?.pairs.map((pair) => equityLatencyMs(pair.target.receivedAt, referenceAt)).filter((value): value is number => value != null) ?? [];
  const oldestAge = [...sourceAge, ...targetAge].length ? Math.max(...sourceAge, ...targetAge) : null;
  if (mode === "LIVE") {
    return (
      <section className="fmv2-operations" aria-label="LIVE 준비 상태">
        <div className="fmv2-section-heading"><div><span className="eyebrow">LIVE READINESS · READ ONLY</span><h2>실전 준비 체크리스트</h2></div><span>실행 UI 없음</span></div>
        <ul>
          <li><span className={service?.liveGate.configured ? "is-good" : "is-muted"} />서버 구성 {service?.liveGate.configured ? "관측됨" : "—"}</li>
          <li><span className={service?.liveGate.armed ? "is-warn" : "is-muted"} />Arm 상태 {service?.liveGate.armed ? "서버가 보고함" : "LOCKED / 미노출"}</li>
          <li><span className="is-bad" />브라우저 실행 권한 API canStart=false</li>
          <li><span className={snapshot?.connected && !snapshot.stale ? "is-good" : "is-warn"} />가장 오래된 계정 관측 {oldestAge == null ? "—" : `${formatNumber(oldestAge, 0)}ms 전`}</li>
        </ul>
      </section>
    );
  }
  return (
    <section className="fmv2-operations" aria-label="PAPER 가정과 관측 제한">
      <div className="fmv2-section-heading"><div><span className="eyebrow">PAPER ASSUMPTIONS</span><h2>모의투자 가정과 관측 제한</h2></div><span>실행 제어 없음</span></div>
      <ul>
        <li><span className="is-good" />현재 L2 기준 bootstrap · source 포지션과 shadow order 비교</li>
        <li><span className="is-muted" />Maker / taker fee, slippage 세부값: API 미제공 —</li>
        <li><span className="is-muted" />가장 오래된 계정 관측 {oldestAge == null ? "—" : `${formatNumber(oldestAge, 0)}ms 전`} · 마지막 폴 {formatTime(lastCheckedAt)}</li>
        <li><span className="is-warn" />유동성·부분체결·근사 청산 표시는 서버 관측값이 있을 때만 반영</li>
      </ul>
    </section>
  );
}

export default function FaithfulMirrorDashboard({ mode, status }: { mode: MirrorViewMode; status: FaithfulMirrorStatus }) {
  const snapshot = status.snapshot;
  const pairs = snapshot?.pairs ?? [];
  const sourceEquity = knownTotal(pairs.map((pair) => pair.source.equityUsd));
  const followerEquity = knownTotal(pairs.map((pair) => pair.target.equityUsd));
  const sourcePnl = knownTotal(pairs.map((pair) => numberAt(pair.metrics, ["sourcePnlUsd", "sourcePnl", "sourceEquityPnlUsd"])));
  const followerPnl = knownTotal(pairs.map((pair) => numberAt(pair.metrics, ["targetPnlUsd", "followerPnlUsd", "targetPnl", "followerPnl"])));
  const activePairs = pairs.filter((pair) => pairStatus(pair) === "RUNNING").length;
  const protectedPairs = pairs.filter((pair) => pair.killed || pair.blocked).length;
  const connectionTone = !snapshot?.connected ? "disconnected" : snapshot.stale ? "stale" : "connected";
  const connectionLabel = !snapshot?.connected
    ? "로컬 서비스 연결 안 됨"
    : snapshot.stale
      ? "상태 지연"
      : "1초 상태 수신 중";
  const lockReason = snapshot?.service.liveGate.reason ?? "LIVE는 이 화면에서 잠겨 있습니다. 이 UI는 상태를 읽기만 하며 arm, start, 주문 전송을 제공하지 않습니다.";

  return (
    <section className="fmv2-shell" aria-label={`Faithful Mirror V2 ${mode} 대시보드`}>
      <header className="fmv2-hero">
        <div>
          <span className="eyebrow">FAITHFUL MIRROR V2 · {mode}</span>
          <h1>{mode === "PAPER" ? "모의투자 상태 미러" : "Hyperliquid 실전투자"}</h1>
          <p>1–5개 고래의 소스 상태와 팔로워 상태를 같은 관측 단위로 비교합니다. 화면은 읽기 전용이며 실행 제어를 제공하지 않습니다.</p>
        </div>
        <div className={`fmv2-connection fmv2-connection--${connectionTone}`} role="status" aria-live="polite">
          <span />
          <div><strong>{connectionLabel}</strong><small>최근 확인 {formatTime(status.lastCheckedAt)}</small></div>
        </div>
      </header>

      <aside className="fmv2-provenance">
        <strong>COHORT PROVENANCE</strong>
        <span>2026-08-21 고정 스냅샷 · PORTFOLIO_ONLY_ESTIMATE</span>
        <p>6,272개 지갑 저장 보고서 기반입니다. 이 화면의 TWR은 VERIFIED 또는 cash-flow-neutral 성과가 아닙니다.</p>
      </aside>

      {mode === "LIVE" ? (
        <aside className="fmv2-live-lock" aria-label="LIVE 실행 잠금">
          <span>LOCKED</span>
          <div><strong>실전 실행 제어는 노출되지 않습니다</strong><p>{lockReason}</p></div>
          <small>GATE {snapshot?.service.liveGate.state ?? "LOCKED"} · API canStart=false</small>
        </aside>
      ) : null}

      {status.error ? <p className="fmv2-alert fmv2-alert--error" role="alert">{status.error}</p> : null}
      {snapshot?.stale ? <p className="fmv2-alert">상태가 오래되었습니다: {snapshot.staleReason ?? "마지막 정상 관측 이후 30초를 넘었을 수 있습니다."}</p> : null}

      <section className="fmv2-kpis" aria-label="Faithful Mirror 핵심 지표">
        <div><span>소스 합산 Equity</span><strong>{formatUsd(sourceEquity, 0)}</strong><small>PnL {formatUsd(sourcePnl, 0)}</small></div>
        <div><span>팔로워 합산 Equity</span><strong>{formatUsd(followerEquity, 0)}</strong><small>PnL {formatUsd(followerPnl, 0)}</small></div>
        <div><span>실행 중 / 전체</span><strong>{activePairs} / {pairs.length || 5}</strong><small>초기화 {pairs.filter((pair) => pair.initialized).length}쌍</small></div>
        <div><span>보호 정지</span><strong className={protectedPairs ? "is-negative" : "is-positive"}>{protectedPairs}</strong><small>차단·KILLED 쌍</small></div>
        <div><span>서비스 상태</span><strong>{snapshot?.service.state ?? "UNKNOWN"}</strong><small>{snapshot?.service.recoveryAvailable ? "복구 체크포인트 있음" : "복구 상태 대기"}</small></div>
      </section>

      <section className="fmv2-status-strip" aria-label="상태 수신 정보">
        <span>관측 {formatTime(snapshot?.observedAt ?? null)}</span>
        <span>세션 {snapshot?.service.sessionId ? shortAddress(snapshot.service.sessionId) : "대기"}</span>
        <span>서비스 모드 {snapshot?.service.mode ?? "UNKNOWN"}</span>
        <span>{status.loading ? "갱신 중" : "자동 갱신 1초"}</span>
      </section>

      <section className="fmv2-observability-grid" aria-label="세션 관측 및 운영 제한">
        <EquitySparkline samples={status.equitySamples} />
        <OperationalNotes mode={mode} snapshot={snapshot} lastCheckedAt={status.lastCheckedAt} />
      </section>

      <section className="fmv2-whale-grid" aria-label="고래별 상태 카드">
        {pairs.map((pair) => <PairCard key={pair.pairId} pair={pair} />)}
        {!pairs.length ? <div className="fmv2-empty-state fmv2-empty-state--card">서비스 응답을 기다리는 중입니다. 연결이 되면 최대 다섯 개의 고래 상태 카드가 표시됩니다.</div> : null}
      </section>

      <EventFunnel events={snapshot?.events ?? []} />
      <EventTimeline events={snapshot?.events ?? []} />
    </section>
  );
}
