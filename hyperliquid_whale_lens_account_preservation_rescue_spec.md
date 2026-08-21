# Hyperliquid Whale Lens — 고가능성 계좌 전면 보존·구제 파이프라인 개발 명세

**대상 저장소:** `JeongChanilgit/hyperliquid-whale-lens`  
**대상 브랜치 기준:** `feature/verified-perp-twr-pipeline`  
**문서 목적:** 데이터 품질 문제로 현재 `UNVERIFIABLE` 처리되는 계좌를 삭제하거나 영구 탈락시키지 않고, 원본 증거를 전부 보존한 상태에서 여러 수준의 복구·추정·범위 계산을 수행하여 잠재적으로 우수한 계좌를 놓치지 않는 구조를 구현한다.

---

## 0. 핵심 요구사항

현재 검사 풀 6,272명에서 다음 이유로 많은 계좌가 정밀 TWR 후보에서 제외됐다.

```text
30일 cash-flow 경계 부족       2,104명
계좌곡선·입출금 정합성 실패   1,078명
입출금 금액 환산 불가           600명
```

이 수치는 서로 중복될 수 있으므로, 앞으로는 계좌당 하나의 단일 탈락 이유만 저장하지 말고 **복수 reason code와 단계별 증거**를 모두 보존한다.

이번 개선의 목표는 후보 2,000명을 채우는 것이 아니다.

> **발견된 모든 계좌를 영구 보존하고, 데이터가 불완전하더라도 수익률의 정확값·추정값·상하한·미해결 상태를 분리하여 관리하며, 새로운 데이터가 들어올 때 자동으로 재평가·승격하는 시스템을 만든다.**

다음은 금지한다.

```text
UNVERIFIABLE → 데이터 삭제
```

```text
한 가지 검증 실패 → 영구 후보 제외
```

```text
정확한 단일 TWR을 계산할 수 없다는 이유로 잠재수익 정보도 폐기
```

```text
모호한 계좌를 억지로 VERIFIED로 통과
```

정확성과 보존을 동시에 달성해야 한다.

---

# 1. 설계 철학

## 1.1 데이터 품질과 전략 적합성을 분리한다

현재처럼 하나의 `status`에 모든 의미를 넣지 않는다.

계좌마다 최소한 다음 세 축을 별도로 저장한다.

```text
data_quality_status
activity_status
selection_status
```

예시:

```json
{
  "data_quality_status": "BOUNDED",
  "activity_status": "QUALIFIED",
  "selection_status": "HIGH_POTENTIAL_WATCHLIST"
}
```

가능한 값:

### `data_quality_status`

```text
VERIFIED_EXACT
VERIFIED_INTERVAL
VERIFIED_BLOCK_RECONCILED
VERIFIED_DERIVED_VALUE
ESTIMATED_MODIFIED_DIETZ
BOUNDED
PROVISIONAL
RESCUE_PENDING
UNRESOLVED
```

### `activity_status`

```text
QUALIFIED
INSUFFICIENT_COMPLETED_EPISODES
ACTIVITY_UNVERIFIABLE
NOT_YET_SCANNED
```

### `selection_status`

```text
ACTIVE
STANDBY
HIGH_POTENTIAL_WATCHLIST
WATCHLIST
NOT_SELECTED
```

`status=PASS`와 `reason=FEWER_THAN_10_COMPLETED_EPISODES`처럼 상충하는 상태를 만들지 않는다.

## 1.2 원본은 불변으로 보존한다

각 실행에서 가져온 다음 원본은 수정하거나 덮어쓰지 않는다.

- leaderboard row
- raw `portfolio` response
- raw `userNonFundingLedgerUpdates`
- raw `userFillsByTime`
- raw funding events
- 사용한 가격·oracle·candle·asset-context 자료
- API coverage metadata
- pagination observation
- HTTP 오류와 재시도 기록

정규화·분류·TWR 계산은 원본과 별도의 versioned derived artifact로 저장한다.

## 1.3 순위는 뷰이고, 계좌 레지스트리가 본체다

TOP 10, TOP 2,000 같은 숫자는 레지스트리에서 만들어지는 **조회 뷰**일 뿐이다.

본체:

```text
모든 발견 계좌의 누적 증거와 평가 이력
```

따라서 TOP N 밖에 있거나 현재 미해결인 계좌도 삭제하지 않는다.

---

# 2. 계좌 증거 레지스트리

권장 경로:

```text
state/account-evidence-registry/
  accounts/
    0xabc....json
  runs/
    <run_id>.json
  rescue-queue.json
  schema-version.json
```

또는 SQLite/DuckDB를 사용할 수 있다.

## 2.1 계좌 단위 레코드

```json
{
  "wallet": "0x...",
  "first_seen_at_ms": 0,
  "last_seen_at_ms": 0,
  "last_evaluated_run_id": "...",

  "discovery_history": [],
  "evaluation_history": [],
  "raw_artifact_refs": [],

  "latest_scores": {
    "provisional_twr": null,
    "exact_twr": null,
    "estimated_twr": null,
    "twr_lower_bound": null,
    "twr_upper_bound": null
  },

  "data_quality_status": "RESCUE_PENDING",
  "activity_status": "NOT_YET_SCANNED",
  "selection_status": "WATCHLIST",

  "reason_codes": [],
  "rescue_attempts": [],
  "unknown_delta_types": [],

  "last_known_account_value_usd": null,
  "last_known_completed_episodes": null
}
```

## 2.2 평가 이력은 append-only

한 계좌의 상태가 다음처럼 변할 수 있다.

```text
PROVISIONAL
→ CASHFLOW_BOUNDARY_MISSING
→ VERIFIED_INTERVAL
→ ACTIVITY_QUALIFIED
→ STANDBY
```

이전 상태를 덮어쓰지 말고 이력을 추가한다.

---

# 3. 전체 구제 파이프라인

```text
모든 발견 계좌
    │
    ├─ VERIFIED_EXACT 계좌
    │      └─ 기존 정확 순위
    │
    └─ 실패·모호 계좌
           │
           ▼
      1. 실패 사유 세분화
           │
           ▼
      2. 이벤트의 perp 관련성 재분류
           │
           ▼
      3. 점 경계가 아닌 interval 매칭
           │
           ▼
      4. 인접 block reconciliation
           │
           ▼
      5. guard sample 및 겹치는 기간 보강
           │
           ▼
      6. USD 금액 원본 복원
           │
           ▼
      7. 가격 기반 USD 범위 산출
           │
           ▼
      8. Modified Dietz 및 TWR 상하한
           │
           ▼
      9. event-time equity 정밀 재구성
           │
           ▼
     10. 품질 등급과 watchlist 승격
```

각 단계에서 성공한 계좌는 그 품질 수준으로 보존한다. 다음 단계까지 반드시 진행해야 하는 것은 아니다.

---

# 4. 실패 원인 진단을 먼저 세분화한다

현재 세 가지 큰 reason code를 더 작은 하위 코드로 나눈다.

## 4.1 cash-flow 경계 부족

```text
BOUNDARY_DISTANCE_5S_TO_30S
BOUNDARY_DISTANCE_30S_TO_2M
BOUNDARY_DISTANCE_2M_TO_15M
BOUNDARY_DISTANCE_OVER_15M
NO_PREDECESSOR_SAMPLE
NO_SUCCESSOR_SAMPLE
FLOW_BETWEEN_SAMPLES
MULTIPLE_FLOWS_SAME_INTERVAL
FLOW_AND_PNL_SAME_INTERVAL
NON_PERP_EVENT_REQUIRES_NO_BOUNDARY
WINDOW_EDGE_COVERAGE_GAP
```

필수 진단 필드:

```text
nearest_boundary_distance_ms
left_sample_time_ms
right_sample_time_ms
containing_interval_ms
flow_count_in_interval
flow_sum_usd
delta_pnl_in_interval
```

## 4.2 정합성 실패

```text
TRANSIENT_POSITIVE_RESIDUAL
TRANSIENT_NEGATIVE_RESIDUAL
ALTERNATING_RESIDUAL
PERSISTENT_STEP_RESIDUAL
BLOCK_2_RECONCILES
BLOCK_4_RECONCILES
BLOCK_8_RECONCILES
MARK_TIMING_SUSPECTED
MISSING_FLOW_SUSPECTED
PERSISTENT_UNEXPLAINED_RESIDUAL
```

필수 진단 필드:

```text
residual_usd
residual_ratio
residual_next_1
residual_sum_2
residual_sum_4
residual_sum_8
open_position_notional_usd
position_count
hip3_position_count
```

## 4.3 금액 환산 불가

```text
PURE_SPOT_EVENT
PURE_STAKING_EVENT
NON_POSITION_REWARD
MISSING_USDC_VALUE
NON_USD_TOKEN_FLOW
RAW_LEDGER_ENRICHMENT_AVAILABLE
PRICE_AT_EVENT_AVAILABLE
PRICE_RANGE_ONLY
UNPRICED_TOKEN
UNKNOWN_ACCOUNT_CLASS
```

필수 진단 필드:

```text
delta_type
token
token_amount
raw_usdc_value
price_source
price_low
price_high
derived_flow_low
derived_flow_high
```

---

# 5. 30일 cash-flow 경계 부족 2,104명 구제

## 5.1 perp와 무관한 이벤트를 먼저 분리

모든 non-funding ledger event가 `perpMonth` cash flow는 아니다.

다음은 계좌 class와 실제 perp equity 영향을 확인한 후 `NOT_A_PERP_CASHFLOW`로 분류할 수 있다.

```text
spotTransfer
spotGenesis
rewardsClaim
accountActivationGas
cStakingTransfer
stakingReward
validatorReward
deployGasAuction
```

단, portfolio margin 또는 spot collateral이 perp equity에 영향을 미치는 계정에서는 무조건 무시하면 안 된다.

판정 규칙:

```text
1. event type과 toPerp/account class 필드 확인
2. event 전후 perpMonth equity 변화 확인
3. perp equity 변화가 없고 순수 spot/staking임이 확인되면
   NOT_A_PERP_CASHFLOW
4. 계정 모드가 불명확하면 RESCUE_PENDING
```

이렇게 분류된 이벤트는 perp cash-flow boundary를 요구하지 않는다.

## 5.2 5초 점 매칭을 interval 매칭으로 확장

현재 방식:

```text
flow time ≈ sample time ± 5초
```

개선 방식:

```text
sample t_i < flow time <= sample t_(i+1)
```

flow를 한 sample point가 아니라 **두 sample 사이 구간**에 소속시킨다.

### 구간 PnL이 0인 경우

```text
delta_pnl == 0
```

이고:

```text
E_end - E_start == net_flow ± tolerance
```

이면 flow의 정확한 구간 내 순서와 무관하게 구간 수익률은 0이다.

품질:

```text
VERIFIED_INTERVAL
```

### flow가 있어도 equity가 변하지 않는 경우

상쇄되는 다중 flow일 수 있다.

```text
deposit + withdrawal = 0
```

raw events를 모두 보존하고 순유입을 사용한다.

## 5.3 flow와 PnL가 같은 구간에 있는 경우

정확한 단일 TWR 대신 범위를 계산한다.

구간 시작 equity:

```text
E0
```

순입금:

```text
F_in
```

순출금 절댓값:

```text
F_out
```

구간 PnL:

```text
delta_pnl
```

가능한 운용 자본 범위:

```text
capital_low  = max(epsilon, E0 - F_out)
capital_high = E0 + F_in
```

PnL의 부호에 따라 보수적인 구간 수익률 하한·상한을 계산한다.

```text
r_a = delta_pnl / capital_low
r_b = delta_pnl / capital_high

interval_return_lower = min(r_a, r_b)
interval_return_upper = max(r_a, r_b)
```

여러 구간의 범위는 interval arithmetic로 복리 연결한다.

```text
growth_lower *= 1 + r_lower
growth_upper *= 1 + r_upper
```

결과:

```text
twr_lower_bound
twr_upper_bound
data_quality_status = BOUNDED
```

## 5.4 Modified Dietz 추정치

flow 시각은 알고 있지만 정확한 flow 직전 equity가 없는 경우 Modified Dietz를 추가 계산한다.

\[
R =
\frac{E_1 - E_0 - \sum F_j}
{E_0 + \sum w_j F_j}
\]

\[
w_j =
\frac{T - t_j}{T}
\]

이 값은 정확 TWR이 아니므로:

```text
estimated_twr_method = MODIFIED_DIETZ
data_quality_status = ESTIMATED_MODIFIED_DIETZ
```

로 저장한다.

정확값처럼 표시하지 않는다.

## 5.5 30일 window guard sample

다음 기간의 겹치는 sample을 보조로 사용한다.

```text
perpWeek
perpMonth
perpAllTime
```

목적:

- window start 직전 predecessor sample
- window end 직후 successor sample
- 첫·마지막 cash-flow 경계 검증

규칙:

1. 같은 timestamp의 값이 동일해야 한다.
2. 겹치는 구간의 account value와 PnL가 일관되어야 한다.
3. guard sample은 평가 window 밖의 수익을 포함하지 않는다.
4. 값이 충돌하면 사용하지 않는다.

품질:

```text
VERIFIED_INTERVAL_WITH_GUARD
```

---

# 6. 계좌곡선·입출금 정합성 실패 1,078명 구제

## 6.1 현재 오차 검사는 진단용으로 유지하되 단일 탈락 판정에서 분리

현재와 같은:

```text
max($0.05, account_value × 0.000001)
```

검사는 `EXACT` 등급 판정에는 사용할 수 있다.

하지만 이를 넘었다고 계좌 자체를 폐기하지 않는다.

```text
EXACT tolerance 실패
→ block reconciliation
→ empirical noise tolerance
→ bounded/estimated
→ event-time reconstruction
```

순으로 진행한다.

## 6.2 PnL 기반과 equity 기반 수익률을 동시에 계산

```text
r_pnl = delta_pnl / E_previous
```

```text
r_equity =
(E_current - E_previous - net_external_flow)
/
E_previous
```

저장:

```text
return_disagreement = r_equity - r_pnl
```

절대 residual뿐 아니라 수익률 차이가 최종 결과에 미치는 영향을 본다.

## 6.3 block reconciliation

그래프 update phase가 어긋난 경우 인접 residual이 상쇄될 수 있다.

다음 블록을 시도한다.

```text
2 samples
4 samples
8 samples
```

블록 식:

```text
E_block_end
≈ E_block_start
+ block_delta_pnl
+ block_net_flow
```

성공 조건:

- 블록 누적 residual이 calibrated tolerance 이내
- 블록 안에 unknown flow가 없음
- 블록 시작·끝 equity가 양수
- 블록 전체 return이 -100% 미만이 아님
- residual이 다음 블록으로 persistent하게 이어지지 않음

품질:

```text
VERIFIED_BLOCK_RECONCILED
```

개별 15분 수익률 대신 블록 단위 수익률을 복리 연결한다.

## 6.4 residual 패턴 분류

### 상쇄형

```text
+$100
-$99.98
```

업데이트 시차 가능성이 높다.

### persistent step

```text
+$100
+$100
+$100
```

누락 flow 가능성이 높다.

상쇄형은 block reconciliation 대상으로, persistent step은 raw ledger enrichment 대상으로 보낸다.

## 6.5 경험적 graph-noise 모델

cash-flow가 없는 verified 구간을 이용해 residual 분포를 학습하지 말고 **통계적으로 보정**한다.

계층:

```text
account value bucket
sample interval length
open position notional / equity
position count
HIP-3 position presence
timestamp alignment distance
```

각 계층별 사전 고정 percentile:

```text
P99
P99.9
```

을 계산한다.

사용 규칙:

```text
exact_tolerance = 기존 엄격 tolerance
graph_noise_tolerance = 사전 계산된 P99.9 + absolute cap
```

`graph_noise_tolerance` 안에서 block 정합이 되면:

```text
VERIFIED_BLOCK_RECONCILED
```

그보다 크면 bounded 또는 unresolved.

금지:

- 높은 수익률 계좌에만 tolerance 확대
- 결과를 보고 percentile 변경
- wallet별 맞춤 tolerance
- 절대 금액 cap 없는 상대 tolerance

## 6.6 미설명 residual은 수익률 범위로 전파

residual을 무조건 PnL로 넣지 않는다.

미설명 residual 범위:

```text
[-abs_residual, +abs_residual]
```

을 PnL uncertainty로 두고 TWR lower/upper bound에 전파한다.

결과:

```text
data_quality_status = BOUNDED
```

---

# 7. 입출금 금액 환산 불가 600명 구제

## 7.1 환산이 필요 없는 이벤트 제거

순수 spot·staking·reward 이벤트가 perp equity에 영향을 주지 않았다면:

```text
NOT_A_PERP_CASHFLOW
```

로 처리한다.

이 경우 USD 환산이 없어도 perp TWR 계산에 문제가 없다.

## 7.2 원본 이벤트 필드 재탐색

다음 필드를 우선순위로 검색한다.

```text
usdc
usdcValue
netWithdrawnUsd
requestedUsd
commission
closingCost
amount
token
```

Info API 정규화 응답에 없더라도 raw event, node data, explorer/L1 event에서 복원 가능하면 사용한다.

품질:

```text
VERIFIED_DERIVED_VALUE
value_source = RAW_LEDGER_EVENT
```

## 7.3 가격 기반 USD 평가

원본 USD 값이 없고 token amount만 있으면 이벤트 시각 가격을 사용한다.

우선순위:

1. 동일 raw event의 `usdcValue`
2. 동일 block/시각의 oracle
3. asset context의 mark/mid
4. L2 book mid
5. 1m 또는 가능한 최소 candle
6. candle high/low 범위

단일 mid를 정확값으로 취급하지 않는다.

저장:

```text
price_source
price_point
price_low
price_high
flow_usd_point
flow_usd_low
flow_usd_high
```

### spread가 작은 경우

사전 설정된 최대 평가 오차 이내이면:

```text
VERIFIED_DERIVED_VALUE
```

### spread가 큰 경우

```text
BOUNDED
```

으로 유지한다.

## 7.4 계좌곡선 implied flow와 교차검증

```text
implied_flow =
E_current
- E_previous
- delta_pnl
- known_other_flows
```

다음을 확인한다.

```text
flow_usd_low
<= implied_flow
<= flow_usd_high
```

성립하면 가격 기반 범위가 계좌곡선과 일치한다.

성립하지 않으면:

```text
UNRESOLVED_VALUE_CONFLICT
```

로 남긴다.

---

# 8. 최후 단계: event-time equity 정밀 재구성

상위 잠재 계좌 중 앞 단계에서 여전히 넓은 범위만 남는 경우 수행한다.

필요 데이터:

- raw fills
- position size history
- entry/exit price
- funding
- fee/rebate
- mark/oracle price
- cash-flow event
- clearinghouse snapshot
- asset metadata
- liquidation event

목표:

cash-flow 직전과 직후의 계좌 equity를 재구성한다.

```text
cash
+ realized PnL
+ unrealized PnL
+ funding
- fees
+ external flow
```

이 단계는 고비용이므로 전체 계좌에 매일 수행하지 않는다.

그러나 **모든 계좌를 보존**하므로 현재 처리하지 못한 계좌도 rescue queue에 남아 이후 계산할 수 있다.

---

# 9. 수익률을 하나가 아니라 여러 형태로 저장

```json
{
  "provisional_twr": "...",
  "exact_twr": null,
  "estimated_twr": "...",
  "twr_lower_bound": "...",
  "twr_upper_bound": "...",
  "metric_method": "MODIFIED_DIETZ",
  "data_quality_status": "ESTIMATED_MODIFIED_DIETZ"
}
```

## 9.1 순위 뷰

### 실행 가능한 정확 계좌

```text
Exact Ranking
```

허용 품질:

```text
VERIFIED_EXACT
VERIFIED_INTERVAL
VERIFIED_BLOCK_RECONCILED
VERIFIED_DERIVED_VALUE
```

단, derived-value 오차가 순위에 영향을 주지 않아야 한다.

### 고가능성 watchlist

```text
High-Potential Watchlist
```

정렬 예시:

```text
twr_lower_bound DESC
twr_upper_bound DESC
estimated_twr DESC
```

### 미해결 잠재군

```text
Unresolved Potential Accounts
```

정렬은 `rescue_priority_score`를 사용하되 최종 수익률 순위라고 부르지 않는다.

---

# 10. rescue priority score

모든 계좌는 보존하지만 처리 순서는 정한다.

권장 입력:

```text
provisional_twr percentile
twr_upper_bound percentile
twr_lower_bound percentile
current account value
activity proxy
nearest boundary distance
block residual cancellation ratio
known USD-value recovery availability
last successful data fetch age
```

예시:

```text
rescue_priority_score =
0.30 * provisional_twr_percentile
+ 0.30 * upper_bound_percentile
+ 0.15 * activity_proxy_percentile
+ 0.10 * account_value_percentile
+ 0.10 * recoverability_score
+ 0.05 * freshness_score
```

이 점수는:

- rescue 작업 순서
- API budget 배분
- dashboard 표시

에만 사용한다.

최종 투자 순위에 사용하지 않는다.

---

# 11. 모든 계좌를 보존하는 lifecycle

```text
DISCOVERED
→ PROVISIONAL_SCORED
→ VERIFIED_EXACT
```

또는:

```text
DISCOVERED
→ PROVISIONAL_SCORED
→ RESCUE_PENDING
→ VERIFIED_INTERVAL
```

또는:

```text
DISCOVERED
→ RESCUE_PENDING
→ BOUNDED
→ VERIFIED_DERIVED_VALUE
```

또는:

```text
DISCOVERED
→ RESCUE_PENDING
→ UNRESOLVED
```

`UNRESOLVED`도 삭제가 아니다.

새 데이터, 새 classifier, 새 price source, 다음 run의 더 좋은 boundary가 생기면 자동 재평가한다.

---

# 12. rescue queue

```json
{
  "wallet": "0x...",
  "priority": 0.91,
  "reason_codes": [
    "CASHFLOW_BOUNDARY_MISSING",
    "NON_USD_FLOW_UNPRICED"
  ],
  "next_actions": [
    "RECLASSIFY_ACCOUNT_CLASS",
    "INTERVAL_MATCH",
    "FETCH_RAW_LEDGER",
    "FETCH_EVENT_PRICE"
  ],
  "attempt_count": 1,
  "last_attempt_at_ms": 0,
  "next_retry_at_ms": 0
}
```

큐는 deterministic해야 한다.

같은 입력과 같은 rescue engine version이면 같은 순서가 나와야 한다.

---

# 13. API budget과 지속적 개선

## 13.1 일일 구조

```text
신규 발견 계좌
+ 기존 exact 계좌 갱신
+ rescue queue 상위 계좌
+ 오래된 unresolved 계좌 rotating sample
```

## 13.2 starvation 방지

고가능성 계좌만 계속 처리하면 낮은 우선순위 계좌가 영원히 남을 수 있다.

예:

```text
70% budget: high-potential rescue
20% budget: oldest unresolved
10% budget: random deterministic audit sample
```

## 13.3 재시도

다음은 일정 시간이 지나면 재시도한다.

- HTTP 429
- endpoint outage
- missing boundary near window edge
- temporary missing price
- incomplete node archive

다음은 engine version이 바뀔 때 재평가한다.

- unknown delta type
- unsupported account class
- valuation logic 개선
- tolerance model 개선

---

# 14. 보고서

## 14.1 전체 보존 통계

```text
discovered_accounts
exact_accounts
interval_verified_accounts
block_reconciled_accounts
derived_value_accounts
estimated_accounts
bounded_accounts
rescue_pending_accounts
unresolved_accounts
```

## 14.2 원인별 구제 결과

```text
cashflow_boundary_missing_total
cashflow_boundary_rescued_interval
cashflow_boundary_rescued_guard
cashflow_boundary_bounded
cashflow_boundary_unresolved

reconciliation_failed_total
reconciliation_rescued_block2
reconciliation_rescued_block4
reconciliation_rescued_block8
reconciliation_bounded
reconciliation_unresolved

unpriced_flow_total
unpriced_flow_reclassified_non_perp
unpriced_flow_recovered_raw_usd
unpriced_flow_recovered_price
unpriced_flow_bounded
unpriced_flow_unresolved
```

## 14.3 dashboard

다음 탭을 둔다.

```text
정확 검증
구제 검증
상하한 후보
미해결 고가능성
전체 계좌
```

계좌별로 다음을 표시한다.

- exact/estimated/bounded 구분
- 수익률 상하한
- 실패·구제 이력
- 사용한 가격 source
- boundary distance
- block reconciliation 결과
- 활동성 상태
- 다음 rescue action

---

# 15. reason code와 품질 enum

## 15.1 reason code

```text
CASHFLOW_BOUNDARY_MISSING
FLOW_BETWEEN_SAMPLES
FLOW_AND_PNL_SAME_INTERVAL
WINDOW_EDGE_COVERAGE_GAP

RECONCILIATION_RESIDUAL_TOO_LARGE
TRANSIENT_RESIDUAL
ALTERNATING_RESIDUAL
PERSISTENT_RESIDUAL
MARK_TIMING_SUSPECTED
MISSING_FLOW_SUSPECTED

NON_USD_FLOW_UNPRICED
PURE_SPOT_EVENT
PURE_STAKING_EVENT
NON_POSITION_REWARD
RAW_LEDGER_VALUE_MISSING
PRICE_RANGE_TOO_WIDE
VALUE_CONFLICT

EVENT_TIME_RECONSTRUCTION_REQUIRED
RESCUE_BUDGET_DEFERRED
UNRESOLVED
```

## 15.2 quality enum

```text
VERIFIED_EXACT
VERIFIED_INTERVAL
VERIFIED_INTERVAL_WITH_GUARD
VERIFIED_BLOCK_RECONCILED
VERIFIED_DERIVED_VALUE
ESTIMATED_MODIFIED_DIETZ
BOUNDED
PROVISIONAL
RESCUE_PENDING
UNRESOLVED
```

---

# 16. 권장 코드 변경

## 16.1 신규 모듈

```text
src/whale_lens/
  rescue.py
  evidence_registry.py
  interval_twr.py
  valuation.py
  reconciliation.py
```

## 16.2 기존 모듈

### `portfolio.py`

- strict point boundary 결과 보존
- interval container 생성
- guard sample 지원
- sample provenance 저장

### `ledger.py`

- perps 관련성 분류
- account class 확인
- raw USD field enrichment
- multiple reason codes
- event provenance

### `twr.py`

- exact TWR
- interval verified TWR
- block TWR
- Modified Dietz
- lower/upper bound propagation

### `pipeline.py`

- 탈락 대신 registry 저장
- rescue queue 생성
- stage별 재시도
- exact ranking과 watchlist 분리

### `report.py`

- 보존·구제 통계
- 품질별 순위
- unresolved 목록

### dashboard

- 단일 PASS/DROP 표시 제거
- data/activity/selection 상태 분리

---

# 17. 테스트 체크리스트

## 17.1 보존

- [ ] 모든 discovery 계좌가 registry에 저장된다.
- [ ] 검증 실패 계좌도 삭제되지 않는다.
- [ ] raw response reference가 유지된다.
- [ ] 평가 이력이 append-only다.
- [ ] 같은 계좌의 여러 reason code가 함께 저장된다.
- [ ] 새 run이 이전 evidence를 덮어쓰지 않는다.

## 17.2 상태 분리

- [ ] data quality와 activity status가 분리된다.
- [ ] selection status가 별도다.
- [ ] `PASS + FEWER_THAN_10_EPISODES` 같은 모순이 불가능하다.
- [ ] `UNRESOLVED` 계좌도 watchlist에 남길 수 있다.

## 17.3 cash-flow 경계

- [ ] pure spot event가 perp boundary를 요구하지 않는다.
- [ ] pure staking event가 perp boundary를 요구하지 않는다.
- [ ] `delta_pnl=0` interval flow가 정확히 0%로 구제된다.
- [ ] multiple flow가 같은 interval에서 순유입으로 계산된다.
- [ ] flow+PnL interval에 TWR 상하한이 생성된다.
- [ ] Modified Dietz estimate가 exact로 표시되지 않는다.
- [ ] guard sample이 window 밖 수익을 포함하지 않는다.
- [ ] conflicting guard sample은 거부된다.

## 17.4 정합성

- [ ] alternating residual이 감지된다.
- [ ] 2-sample block reconciliation이 작동한다.
- [ ] 4-sample block reconciliation이 작동한다.
- [ ] 8-sample block reconciliation이 작동한다.
- [ ] persistent residual은 block verified로 통과하지 않는다.
- [ ] empirical tolerance가 결과를 보고 변하지 않는다.
- [ ] absolute cap이 존재한다.
- [ ] residual uncertainty가 TWR bounds로 전파된다.

## 17.5 금액 환산

- [ ] raw `usdcValue`가 우선 사용된다.
- [ ] vault withdrawal net amount가 정확히 계산된다.
- [ ] token amount만 있을 때 가격 source가 기록된다.
- [ ] candle high/low로 flow 범위가 생성된다.
- [ ] implied flow와 가격 범위가 교차검증된다.
- [ ] 범위가 넓으면 exact로 승격되지 않는다.
- [ ] price source가 없으면 unresolved로 보존된다.

## 17.6 순위와 watchlist

- [ ] exact ranking에 허용 품질만 들어간다.
- [ ] bounded 계좌가 exact ranking에 섞이지 않는다.
- [ ] high-potential watchlist가 별도로 생성된다.
- [ ] lower/upper bound가 표시된다.
- [ ] rescue priority가 최종 투자 순위로 사용되지 않는다.
- [ ] TOP N 밖 계좌도 registry에 남는다.

## 17.7 lifecycle

- [ ] unresolved 계좌가 다음 run에서 자동 재평가된다.
- [ ] classifier version 변경 시 해당 계좌가 재큐잉된다.
- [ ] 가격 자료가 새로 생기면 재평가된다.
- [ ] 429 실패는 일정 후 재시도된다.
- [ ] 낮은 priority 계좌도 starvation 없이 처리된다.

---

# 18. 실제 데이터 검증

세 실패군에서 최소 50명씩 표본을 뽑아 수동 감사한다.

## 18.1 boundary group

분포:

```text
5~30초
30초~2분
2~15분
15분 초과
```

각 구간별 구제율을 기록한다.

## 18.2 reconciliation group

분류:

```text
alternating
block2
block4
block8
persistent
```

실제 missing flow인지 graph lag인지 표본 감사한다.

## 18.3 unpriced group

delta type별 count와 결과:

```text
non-perp reclassification
raw USD recovered
price recovered
bounded only
unresolved
```

을 기록한다.

---

# 19. 완료 조건

1. 6,272명 검사 풀의 모든 계좌가 evidence registry에 남는다.
2. 세 실패군도 삭제되지 않는다.
3. 각 계좌는 exact, estimated, bounded, unresolved 중 하나로 표현된다.
4. cash-flow point matching 실패가 interval rescue로 이어진다.
5. 정합성 실패가 block reconciliation로 재평가된다.
6. 비USD flow가 account class·raw value·가격 범위로 재평가된다.
7. 정확한 단일 값이 불가능하면 TWR 범위를 보존한다.
8. exact ranking과 high-potential watchlist가 분리된다.
9. activity status와 data quality가 분리된다.
10. 다음 run에서 자동 승격·재평가된다.
11. 모든 raw evidence와 calculation version이 추적 가능하다.
12. 개발 에이전트가 실패군별 구제율과 남은 unresolved count를 보고한다.

---

# 20. 개발 에이전트 제출 형식

```markdown
## 변경 요약

## 변경 파일

## evidence registry 구조

## 상태 모델
- data quality:
- activity:
- selection:

## cash-flow 경계 구제 결과
- total:
- non-perp reclassified:
- interval verified:
- guard verified:
- bounded:
- unresolved:

## 정합성 실패 구제 결과
- total:
- block2:
- block4:
- block8:
- bounded:
- persistent unresolved:

## 금액 환산 불가 구제 결과
- total:
- raw USD recovered:
- price recovered:
- non-perp reclassified:
- bounded:
- unresolved:

## 품질별 계좌 수
- VERIFIED_EXACT:
- VERIFIED_INTERVAL:
- VERIFIED_BLOCK_RECONCILED:
- VERIFIED_DERIVED_VALUE:
- ESTIMATED_MODIFIED_DIETZ:
- BOUNDED:
- RESCUE_PENDING:
- UNRESOLVED:

## 테스트 결과

## 실제 데이터 표본 감사

## 정확 순위와 고가능성 watchlist

## 남은 위험
```

---

# 21. 최종 기대 구조

```text
모든 발견 계좌
    │
    ▼
불변 raw evidence 보존
    │
    ▼
provisional score
    │
    ├─ exact validation 성공
    │      └─ exact ranking
    │
    └─ validation 실패
           │
           ▼
      rescue diagnostics
           │
           ├─ interval verified
           ├─ block reconciled
           ├─ derived value verified
           ├─ modified Dietz estimate
           ├─ TWR bounds
           └─ unresolved
                    │
                    ▼
        high-potential watchlist
                    │
                    ▼
          다음 run 자동 재평가
```

이 구조의 최종 목표:

> **데이터가 불완전하다는 이유로 가능성 있는 계좌를 버리지 않는다. 정확한 계좌는 정확 순위에, 불확실하지만 유망한 계좌는 상하한과 증거 수준을 갖춘 watchlist에 보존하고, 새로운 데이터가 들어올 때 자동으로 승격한다.**
