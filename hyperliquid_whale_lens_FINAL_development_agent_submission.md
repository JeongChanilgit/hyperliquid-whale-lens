# Hyperliquid Whale Lens 최종 개발 에이전트 제출 명세

**대상 저장소:** `JeongChanilgit/hyperliquid-whale-lens`  
**제출본 버전:** 2026-08-21 Final  
**목적:** 최근 30일 동안 입출금으로 부풀려지지 않은 perpetual 포지션 운용 복리수익률을 계산하고, 활동성이 충분한 고래 10명을 비용 제한 안에서 선정하도록 스크리너·보고서·상태 파일·모의투자 연동을 개편한다.

---

## 0. 최종 요구사항 요약

매일 수만 개 지갑을 모두 정밀 계산하지 않는다.

다음 5단계 파이프라인을 구현한다.

```text
1. leaderboard 전체에서 저비용 다중 신호로 discovery pool 5,000~7,000명 생성
2. discovery pool의 portfolio.perpMonth로 provisional TWR 계산
3. provisional 상위 2,500명부터 non-funding ledger로 입출금 정밀 보정
4. 검증 TWR 상위 2,000명을 candidate pool로 고정
5. candidate를 검증 TWR 순서대로 raw fills 검사하여
   완결 포지션 에피소드가 10회 이상인 첫 10명을 ACTIVE로 선정
```

최종 정렬 지표는 오직 다음이다.

```text
perp_cashflow_neutral_twr_30d
```

`leaderboard month.roi`는 초기 발견 신호 중 하나로만 사용한다. 다음 용도로는 사용할 수 없다.

- 최종 수익률
- 단독 후보 절단 기준
- 검증 후보 2,000명 확정 기준
- 최종 TOP 10 정렬 기준

다음 구현은 실패로 판정한다.

```text
기존 candidate-limit 500을 2000으로만 변경
```

```text
leaderboard month.roi 상위 2000명
→ perpMonth 재계산
```

```text
전체 적격 지갑을 매일 portfolio + ledger + fills로 모두 정밀 계산
```

---

# 1. 비즈니스 목표

최종적으로 다음 조건의 지갑 10명을 찾는다.

1. 최근 30일 perpetual 포지션 운용 성과가 높다.
2. 입금·출금·이체·vault 이동·비거래성 보상은 수익에서 제거된다.
3. 기간 중 각 코인별 `0 → 포지션 보유 → 다시 0` 완결 에피소드가 합계 10회 이상이다.
4. portfolio, ledger, fill 데이터가 완전하고 서로 정합한다.
5. 검증 불가능한 지갑은 높은 수익률로 추정하지 않는다.
6. 최종 모의투자 runner가 실제로 이 TOP 10을 사용한다.

MDD는 진단값으로 계산할 수 있지만 기본 선정 필터로 사용하지 않는다.

---

# 2. 권장 기본 설정

```text
window_days = 30
minimum_current_account_value_usd = 10000

# discovery pool
leaderboard_roi_top_n = 3000
leaderboard_pnl_top_n = 2000
leaderboard_turnover_top_n = 2000
prior_verified_top_n = 2000
new_wallet_top_n = 500
rotating_sample_n = 500

discovery_pool_target = 6000
discovery_pool_min = 5000
discovery_pool_max = 7000

# exact verification
ledger_verification_initial_n = 2500
ledger_verification_expand_step = 500
boundary_probe_n = 100
candidate_count = 2000

# final activity filter
minimum_completed_episodes = 10
final_active_count = 10

ranking_metric = perp_cashflow_neutral_twr_30d
fill_validation_mode = UNTIL_10
coverage_mode = FAST_INCREMENTAL
mdd_is_filter = false
```

모든 값은 CLI 또는 config로 변경 가능하게 만들되 위 값을 기본값으로 둔다.

---

# 3. 수익률 정의

## 3.1 지표명

코드 필드명:

```text
perp_cashflow_neutral_twr_30d
```

표시명:

```text
30D Perps Cash-Flow-Neutral Compounded Return
```

## 3.2 포함할 포지션 성과

다음은 perpetual 포지션 운용 성과에 포함한다.

- 실현 PnL
- 미실현 PnL 변화
- 거래 수수료
- maker rebate
- funding 지급·수취
- liquidation으로 인한 손익
- perpetual 포지션 운용과 직접 연결된 비용 및 수익

`perpMonth.pnlHistory`와 `perpMonth.accountValueHistory`에 이미 반영된 항목을 별도 API에서 다시 더하거나 빼면 안 된다.

특히 다음은 금지한다.

```text
perpMonth PnL + userFunding
```

```text
perpMonth PnL - fills fee
```

funding과 fee가 이미 portfolio PnL에 포함되어 있다면 이중 반영이 된다.

`userFunding`과 raw fill fee는 감사·정합성 확인용으로만 별도 집계할 수 있다.

## 3.3 제거할 외부 현금흐름

다음은 position-only 수익률에서 제거한다.

- 입금
- 출금
- master ↔ subaccount 이체
- 계정 간 transfer
- spot ↔ perp 이동
- HIP-3 DEX 간 자금 이동
- vault deposit
- vault withdraw
- vault leader commission
- referral reward
- staking 또는 기타 reward
- 외부 commission
- 포지션 손익이 아닌 ledger credit/debit

프로젝트 목적은 카피로 재현 가능한 포지션 수익률이다. 따라서 포지션 거래와 직접 무관한 수익은 외부 현금흐름처럼 중립화한다.

---

# 4. 반드시 통과해야 하는 수익률 예제

아래 예제는 단위 테스트로 그대로 구현한다.

## 4.1 입금만 발생

```text
초기 equity = $1
포지션 PnL = $0
입금 = $100
최종 equity = $101
```

기대 수익률:

```text
0%
```

## 4.2 수익 후 입금

```text
$1 → 포지션 수익으로 $2
그 뒤 $100 입금 → $102
```

기대 수익률:

```text
100%
```

## 4.3 입금 후 수익

```text
$1
$100 입금 → $101
그 뒤 포지션 수익 $1 → $102
```

기대 수익률:

```text
1 / 101 = 약 0.990099%
```

## 4.4 출금만 발생

```text
초기 $100
PnL $0
출금 $90
최종 $10
```

기대 수익률:

```text
0%
```

## 4.5 수익 후 출금

```text
$100 → 거래로 $120
그 뒤 $100 출금 → $20
```

기대 수익률:

```text
20%
```

## 4.6 출금 후 수익

```text
$100
$90 출금 → $10
그 뒤 거래로 $15
```

기대 수익률:

```text
50%
```

## 4.7 입금·출금 왕복

```text
$100
$100 입금 → $200
PnL +$20 → $220
$100 출금 → $120
```

기대 수익률:

```text
10%
```

## 4.8 일반 복리

```text
첫 구간 +10%
둘째 구간 +10%
```

기대 수익률:

```text
21%
```

```text
첫 구간 -50%
둘째 구간 +50%
```

기대 수익률:

```text
-25%
```

---

# 5. 사용할 Hyperliquid 데이터

## 5.1 leaderboard 전체

```text
GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
```

사용 목적:

- 전체 wallet universe 확보
- 현재 account value 조건
- month ROI 발견 버킷
- month absolute PnL 발견 버킷
- month volume 기반 turnover 발견 버킷
- 신규 wallet 감지
- display name 등 보조 메타데이터

사용 금지:

- `month.roi`를 최종 지표로 사용
- `month.roi` 하나만으로 discovery pool 절단
- `month.roi` 상위 2,000명을 final candidate로 확정
- absolute PnL, volume, account value로 최종 정렬
- leaderboard 정보만으로 canonical TOP 10 갱신

필드가 없거나 schema가 달라지면 해당 discovery signal을 비활성화하고 report에 기록한다. 누락값을 임의의 0으로 넣어 가짜 순위를 만들지 않는다.

## 5.2 perpetual portfolio

```json
{
  "type": "portfolio",
  "user": "0x..."
}
```

사용 period:

```text
perpMonth
```

필수 시계열:

```text
accountValueHistory
pnlHistory
```

다음 fallback은 금지한다.

```text
perpMonth 없음 → month 사용
```

`perpMonth`가 없으면 해당 지갑은 `MISSING_PERP_MONTH`.

## 5.3 non-funding ledger

```json
{
  "type": "userNonFundingLedgerUpdates",
  "user": "0x...",
  "startTime": 0,
  "endTime": 0
}
```

용도:

- 입금·출금·transfer·vault·reward 이벤트 시각 확인
- perpMonth sample과 cash flow 정합성 검사
- position-only 수익률에서 비거래성 증감 제거

요청 구간 전체가 완전하게 수집됐는지 검증한다.

- inclusive timestamp overlap 처리
- stable identity deduplication
- pagination stall 감지
- response cap 감지
- cursor 역행 감지

완전성을 증명할 수 없으면:

```text
LEDGER_COVERAGE_INCOMPLETE
```

## 5.4 raw fills

```json
{
  "type": "userFillsByTime",
  "user": "0x...",
  "startTime": 0,
  "endTime": 0,
  "aggregateByTime": false
}
```

용도:

- 포지션 에피소드 재구성
- partial entry/exit 처리
- reversal 처리
- position chain 연속성 검증

최근 10,000 fills 한도에 닿아 전체 30일 완전성을 증명할 수 없으면 `UNVERIFIABLE`.

## 5.5 funding

```json
{
  "type": "userFunding",
  "user": "0x...",
  "startTime": 0,
  "endTime": 0
}
```

기본적으로 감사·진단용이다. `perpMonth` PnL에 다시 합산하지 않는다.

---

# 6. 비용 제한형 초기 discovery pool

## 6.1 전체 적격 universe

leaderboard 전체를 읽은 후 다음 최소 조건만 적용한다.

- 유효한 wallet address
- 현재 account value가 minimum 이상
- 중복 address 제거
- discovery 신호에 필요한 숫자 필드 유효성 확인

## 6.2 discovery 신호 버킷

### A. month ROI

```text
month ROI 상위 3,000명
```

입출금 왜곡 가능성이 있으므로 발견 신호일 뿐이다.

### B. month absolute PnL

```text
month absolute PnL 상위 2,000명
```

큰 자본으로 수익을 낸 지갑을 포착한다.

### C. month turnover

가능한 필드가 있으면 계산한다.

```text
turnover = month_volume / max(current_account_value, minimum_account_value)
```

```text
turnover 상위 2,000명
```

volume이 없으면 이 신호를 비활성화하고 report에 남긴다.

### D. 직전 verified TOP 2,000

직전 성공 run의 검증 TWR 상위 2,000명을 다시 포함한다.

목적:

- leaderboard 신호가 하루 사이 흔들려도 이전 우수 지갑을 놓치지 않음
- 후보 교체 안정성
- 신규 run에서 비교 가능한 retention

주의:

```text
이전 verified score는 현재 run final score로 재사용하지 않는다.
```

현재 discovery에 포함하는 신호일 뿐이다.

### E. 신규 지갑

직전 leaderboard snapshot에 없었으나 이번에 eligibility를 통과한 지갑을 최대 500명 포함한다.

500명을 넘으면 다음 순서로 deterministic하게 선택한다.

```text
current account value DESC
wallet address ASC
```

### F. rotating outside-pool sample

A~E에 없는 적격 지갑에서 500명을 선택한다.

무작위 실행마다 결과가 달라지면 안 된다.

```text
hash(wallet_address + discovery_cycle_id)
```

순으로 선택한다.

## 6.3 합집합 크기

A~F를 합치고 중복 제거한다.

목표:

```text
약 6,000명
```

허용 범위:

```text
최소 5,000명
최대 7,000명
```

5,000명 미만이면 account value rank와 deterministic hash sample로 6,000명까지 채운다.

7,000명을 넘으면 다음을 우선 보존한다.

1. prior verified TOP 2,000
2. 신규 지갑
3. rotating sample

나머지 A/B/C는 deterministic fusion으로 줄인다.

권장:

```text
rrf_score = Σ 1 / (60 + signal_rank)
```

같은 raw input과 `discovery_cycle_id`에서는 항상 동일한 pool이 나와야 한다.

각 지갑의 포함 이유를 저장한다.

```text
MONTH_ROI
MONTH_PNL
TURNOVER
PRIOR_VERIFIED
NEW_WALLET
ROTATING_SAMPLE
FILLER
```

---

# 7. provisional `perpMonth` TWR

discovery pool 5,000~7,000명에 대해서만 `portfolio`를 조회한다.

이 단계에서는 ledger를 아직 받지 않았으므로 cash flow를 임시 추정한다.

```text
delta_pnl = current_pnl - previous_pnl
inferred_flow = current_account - previous_account - delta_pnl
```

입금과 PnL이 동일한 sampled interval에 함께 나타나면 입금이 구간 시작에 있었다고 보는 conservative deposit-first 분모를 사용한다.

결과 필드:

```text
provisional_perp_twr_30d
quality = PROVISIONAL
```

이 값은 오직 ledger verification 대상 선정을 위해 사용한다.

금지:

- final TOP 10 정렬
- VERIFIED 또는 EXACT 표시
- canonical state 갱신
- runner wallet 결정

provisional TWR 상위 2,500명을 최초 ledger verification pool로 선택한다.

---

# 8. ledger 검증 TWR

## 8.1 cash flow 분류기

권장 모델:

```python
class CashFlowClassification(Enum):
    EXTERNAL_IN = "EXTERNAL_IN"
    EXTERNAL_OUT = "EXTERNAL_OUT"
    NON_POSITION_IN = "NON_POSITION_IN"
    NON_POSITION_OUT = "NON_POSITION_OUT"
    NOT_A_CASH_FLOW = "NOT_A_CASH_FLOW"
    UNKNOWN = "UNKNOWN"
```

```python
@dataclass
class ClassifiedCashFlow:
    time_ms: int
    amount_usd: Decimal
    classification: CashFlowClassification
    delta_type: str
    confidence: str
    raw: dict[str, Any]
```

원칙:

1. delta type별 explicit mapping을 작성한다.
2. sender/receiver에 따라 transfer 부호를 정확히 정한다.
3. spot ↔ perp 이동은 perp 관점 부호를 사용한다.
4. vault deposit은 perp capital outflow.
5. vault withdraw은 perp capital inflow.
6. reward·commission은 position PnL이 아니라 neutralized non-position flow.
7. non-USDC flow의 USD 가치를 정확히 알 수 없으면 추측하지 않는다.
8. 새로운 unknown delta type은 wallet을 `UNVERIFIABLE`.
9. raw delta type별 관찰 횟수를 report에 저장한다.
10. 동일 ledger event를 중복 반영하지 않는다.

## 8.2 sample 모델

```python
@dataclass(frozen=True)
class PerpPortfolioSample:
    time_ms: int
    account_value: Decimal
    cumulative_pnl: Decimal
```

```python
@dataclass(frozen=True)
class CashFlowEvent:
    time_ms: int
    amount_usd: Decimal
    delta_type: str
    classification: str
```

## 8.3 fixed evaluation window

run 시작 시 한 번만 고정한다.

```text
as_of_ms
window_start_ms = as_of_ms - 30 days
window_end_ms = as_of_ms
```

모든 지갑은 같은 window로 clip한다.

장시간 실행 중 각 wallet 요청 시각을 새로운 window end로 사용하면 안 된다.

## 8.4 timestamp alignment

권장 기본값:

```text
PORTFOLIO_ALIGNMENT_TOLERANCE_MS = 2000
CASHFLOW_SAMPLE_MATCH_TOLERANCE_MS = 5000
```

원칙:

- exact timestamp 우선
- nearest matching은 one-to-one
- 하나의 flow를 두 sample에 중복 매칭 금지
- 여러 flow가 같은 boundary면 합산하되 raw events 보존
- boundary sample이 없으면 strict mode에서 제외
- 큰 간격을 임의 보간하지 않음

## 8.5 TWR 계산

연속 sample마다:

```text
delta_pnl = current.cumulative_pnl - previous.cumulative_pnl
capital_base = previous.account_value
interval_return = delta_pnl / capital_base
growth_index *= 1 + interval_return
```

최종:

```text
perp_cashflow_neutral_twr_30d = growth_index - 1
```

cash flow는 PnL이 아니라 다음 구간의 capital base만 변경한다.

## 8.6 cash flow 정합성

current boundary의 외부 flow 합을 `flow_at_current`라고 한다.

```text
expected_current_equity
= previous.account_value
+ delta_pnl
+ flow_at_current
```

```text
residual
= current.account_value
- expected_current_equity
```

권장 tolerance:

```text
max(
    $0.05,
    max(abs(previous_equity), abs(current_equity)) * 0.000001
)
```

초과 시:

```text
RECONCILIATION_RESIDUAL_TOO_LARGE
```

금지:

- 큰 residual을 자동 입금으로 처리
- unknown residual을 거래수익으로 처리
- 수익률이 높다는 이유로 tolerance 확대

## 8.7 이벤트 순서 모호성

같은 timestamp에 cash flow와 trading PnL이 함께 있고 순서를 public data로 구분할 수 없으면:

```text
EVENT_ORDER_AMBIGUOUS
```

strict mode에서는 제외한다.

선택적 approximate 모드가 있다면:

```text
quality = APPROXIMATE
```

로 표시하고 기본 candidate pool에 넣지 않는다.

## 8.8 비양수 capital base

```text
capital_base <= 0
```

인데 non-zero PnL이 있으면 정상 수익률을 계산할 수 없다.

- 정확한 전액 손실: -100% 가능
- 0 또는 음수 capital에서 이후 PnL: `NONPOSITIVE_CAPITAL_BASE`
- interval return < -100%: `RETURN_BELOW_MINUS_100`

큰 양수 return은 임의 cap하지 않는다.

대신 다음 진단값을 남긴다.

```text
minimum_capital_base_usd
maximum_interval_return
number_of_extreme_return_intervals
```

---

# 9. ledger verification pool 2,500명과 확장

## 9.1 최초 검증

provisional rank 상위 2,500명에 대해 non-funding ledger를 조회하고 strict TWR을 계산한다.

결과 품질:

```text
VERIFIED
APPROXIMATE
UNVERIFIABLE
```

기본 candidate pool에는 `VERIFIED`만 포함한다.

## 9.2 500명 단위 확장 조건

다음 중 하나면 provisional 다음 순위를 500명 단위로 추가 검증한다.

1. VERIFIED wallet이 2,000명 미만
2. UNVERIFIABLE 비율이 높음
3. candidate 2,000위 cutoff가 불안정함
4. boundary probe에서 cutoff 초과 지갑 발견

## 9.3 boundary probe

초기 verification pool 밖 다음 구간에서 deterministic sample 100명을 검증한다.

예:

```text
provisional rank 2501~3500 중 100명
```

probe wallet의 verified TWR가 현재 candidate 2,000위보다 높으면:

```text
BOUNDARY_BREACH
```

처리:

- verification pool을 500명 확장
- candidate cutoff 재계산
- 다음 boundary probe 반복

discovery pool 끝까지 확장해도 안정되지 않으면:

```text
candidate_pool_complete = false
BOUNDARY_UNSTABLE
```

canonical TOP 10을 갱신하지 않는다.

---

# 10. 검증 TWR TOP 2,000 candidate freeze

VERIFIED wallet만 정렬한다.

1차 정렬:

```text
perp_cashflow_neutral_twr_30d DESC
```

동률 처리:

```text
data_quality_rank DESC
portfolio_observation_count DESC
current_account_value_usd DESC
wallet_address ASC
```

상위 2,000명을 freeze한다.

저장 필드:

```text
candidate_pool_hash
candidate_pool_frozen_at
candidate_pool_source_run_id
candidate_rank
verified_twr
```

동일 input에서는 candidate 순서와 hash가 항상 동일해야 한다.

VERIFIED wallet이 2,000명 미만이면 verification pool을 discovery pool 끝까지 확장한다.

그래도 부족하면:

```text
INSUFFICIENT_VERIFIED_CANDIDATES
candidate_pool_complete = false
```

---

# 11. 완결 포지션 에피소드

candidate 2,000명을 verified TWR 순서대로 검사한다.

한 에피소드:

```text
position == 0
→ first non-zero position
→ additions/reductions
→ position == 0
```

규칙:

- 여러 partial entry는 한 에피소드
- 여러 partial exit는 0이 될 때까지 한 에피소드
- same-direction add/reduce는 새 에피소드가 아님
- long → short reversal:
  - 기존 long 에피소드 종료
  - 새 short 에피소드 시작
- short → long도 동일
- window 시작 전 carry-in position의 청산은 count하지 않음
- window 안에서 시작했지만 아직 열린 포지션은 count하지 않음
- spot fill 제외
- HIP-3 perp `xyz:*`, `para:*` 포함
- coin별 independent position chain
- equal timestamp는 API stable order 보존
- position discontinuity는 추정하지 않음
- 최종 판정은 `aggregateByTime=false` raw fills

통과 조건:

```text
completed_episodes >= 10
```

## 11.1 efficient fill validation

기본 모드:

```text
UNTIL_10
```

candidate rank 1위부터 검사하여 통과자 10명이 나오면 중단한다.

candidate 순서가 이미 verified TWR 순서이므로, 이 첫 10명이 조건을 만족하는 최고 TWR 10명이다.

선택 모드:

```text
FULL_2000
```

candidate 2,000명 전체를 검증하여 standby 후보와 dashboard 활동성 데이터를 생성한다.

보고서 필드:

```text
fill_validation_mode
fills_scanned_candidate_count
```

2,000명을 모두 검사해도 통과자가 10명 미만이면 가짜 10명을 만들지 않는다.

```text
INSUFFICIENT_FINALISTS
```

---

# 12. discovery pool 밖 누락 방지

전체 universe를 매일 정밀 계산하지 않는 이상 전역 상위 2,000명을 수학적으로 보장할 수 없다.

다음 안전장치를 구현한다.

## 12.1 prior verified retention

직전 verified TOP 2,000을 매일 discovery pool에 포함한다.

## 12.2 rotating sample

후보 밖 500명을 매 cycle 평가한다.

동일 cycle에서 재현 가능해야 하며 다음 cycle에서는 다른 지갑으로 진행한다.

## 12.3 shard refresh

후보 밖 eligible universe를 1,000~2,000명 shard로 나눈다.

목표:

```text
7~14일 안에 전체 eligible universe가
최소 한 번 provisional perpMonth 평가를 받음
```

persistent state:

```text
discovery_cycle_id
remaining_shards
last_scored_at_by_wallet
outside_pool_sample_history
```

## 12.4 threshold breach

outside-pool sample 또는 shard wallet의 provisional/verified TWR가 current candidate 2,000위 cutoff보다 높으면:

```text
OUTSIDE_POOL_THRESHOLD_BREACH
```

처리:

- current discovery pool을 8,000 또는 10,000명까지 확대 후 재실행
- 다음 run signal quota 확대
- candidate state 갱신 보류
- `DISCOVERY_POOL_UNSTABLE` 표시

---

# 13. coverage mode와 정직한 순위 표기

## 13.1 FAST_INCREMENTAL

일일 기본 모드.

```text
discovery pool 5,000~7,000
→ provisional scoring
→ ledger verified candidate 2,000
```

표기:

```text
coverage_mode = FAST_INCREMENTAL
ranking_scope = DISCOVERY_POOL_EXACT
coverage_complete = false
```

이를 `GLOBAL TOP 2,000`이라고 표시하면 안 된다.

## 13.2 FULL_DISCOVERY_REFRESH

전체 eligible universe의 `perpMonth` provisional score를 같은 fixed `as_of` 기준으로 계산한다.

그 후 상위 구간을 ledger 검증한다.

실제로 전체 provisional scan이 끝난 경우에만:

```text
coverage_complete = true
ranking_scope = FULL_UNIVERSE_PROVISIONAL_THEN_EXACT
```

full refresh가 미완료되면 canonical state를 덮어쓰지 않는다.

---

# 14. API 비용과 rate limit

일일 호출 구조:

```text
leaderboard: 전체 1회
portfolio: discovery pool 5,000~7,000
ledger: provisional 상위 2,500부터 필요 시 확장
fills: candidate 순서대로, 기본은 finalist 10명 확보 시 종료
```

## 14.1 stage별 budget

```text
portfolio_request_budget
ledger_request_budget
fill_request_budget

portfolio_requests_used
ledger_requests_used
fill_requests_used
```

budget 초과 시 불완전 결과를 ACTIVE로 만들지 않는다.

## 14.2 global limiter

- endpoint weight 기반 global token bucket
- 모든 stage가 limiter 공유
- 429/5xx bounded exponential backoff
- jitter 사용
- wallet별 무한 재시도 금지
- retry exhaustion을 reason code로 기록

---

# 15. cache와 resume

## 15.1 cache key

```text
wallet
endpoint
window_start_ms
window_end_ms
as_of_ms
metric_version
raw_payload_schema_version
coverage_mode
```

## 15.2 cache data

- leaderboard snapshot
- signal ranks
- discovery inclusion reasons
- raw portfolio response
- normalized perpMonth
- provisional TWR
- raw ledger events
- classified cash flows
- verified TWR
- reconciliation diagnostics
- raw fills
- completed episodes

score 숫자만 저장하지 말고 재검산 가능한 raw/normalized 데이터를 보존한다.

## 15.3 freshness

```text
max_provisional_cache_age_hours
max_verified_cache_age_hours
max_fill_cache_age_hours
```

다른 날짜의 verified score를 현재 final score로 재사용하면 안 된다.

prior verified score는 discovery retention 신호로만 사용한다.

## 15.4 checkpoint

```text
run_id
as_of_ms
coverage_mode
eligible_wallets
discovery_signal_buckets
discovery_pool
portfolio_scanned_wallets
provisional_ranking
ledger_verification_cursor
verified_wallets
boundary_probe_results
candidate_top2000_frozen
fill_validation_cursor
finalists
errors
```

resume 조건:

- 같은 run_id
- 같은 as_of
- 같은 metric version
- 같은 discovery pool hash

discovery pool hash가 달라졌는데 ledger cursor를 이어가면 안 된다.

---

# 16. canonical state 갱신 금지 조건

다음 중 하나면 기존 정상 `latest_active_top10.json`을 유지한다.

- leaderboard 로드 실패
- discovery pool 생성 실패
- provisional portfolio coverage 부족
- VERIFIED candidate 2,000 미확보
- boundary instability
- candidate freeze 실패
- final 10명 미확보
- full refresh 미완료
- report write 실패
- candidate hash와 runner config 불일치

중간 결과는 저장할 수 있지만:

```text
run_status = PARTIAL
canonical_state_updated = false
```

atomic write를 사용한다.

---

# 17. 보고서와 상태 스키마

## 17.1 report metadata

```json
{
  "metric_name": "perp_cashflow_neutral_twr_30d",
  "metric_version": "1",
  "run_id": "...",
  "as_of_ms": 0,
  "window_start_ms": 0,
  "window_end_ms": 0,

  "coverage_mode": "FAST_INCREMENTAL",
  "ranking_scope": "DISCOVERY_POOL_EXACT",
  "coverage_complete": false,

  "eligible_universe_count": 0,

  "discovery_pool_target": 6000,
  "discovery_pool_min": 5000,
  "discovery_pool_max": 7000,
  "discovery_pool_actual": 0,

  "discovery_signal_quotas": {
    "month_roi": 3000,
    "month_pnl": 2000,
    "turnover": 2000,
    "prior_verified": 2000,
    "new_wallets": 500,
    "rotating_sample": 500
  },

  "provisional_scored_count": 0,
  "ledger_verification_initial_count": 2500,
  "ledger_verification_actual_count": 0,
  "verified_scored_count": 0,

  "boundary_probe_count": 0,
  "boundary_breach_count": 0,

  "candidate_count_requested": 2000,
  "candidate_count_actual": 0,
  "candidate_pool_complete": true,
  "candidate_pool_hash": "...",

  "minimum_completed_episodes": 10,
  "fill_validation_mode": "UNTIL_10",
  "fills_scanned_candidate_count": 0,

  "outside_pool_sample_count": 0,
  "outside_pool_threshold_breach_count": 0,
  "discovery_cycle_id": "...",

  "canonical_state_updated": true
}
```

## 17.2 wallet row

```json
{
  "wallet": "0x...",
  "current_account_value_usd": "...",

  "discovery_inclusion_reasons": [
    "MONTH_ROI",
    "PRIOR_VERIFIED"
  ],

  "leaderboard_month_roi_rank": 0,
  "leaderboard_month_pnl_rank": 0,
  "leaderboard_turnover_rank": 0,
  "discovery_fusion_score": "...",

  "provisional_perp_twr_30d": "...",
  "provisional_rank": 0,

  "perp_cashflow_neutral_twr_30d": "...",
  "verified_rank": 0,

  "portfolio_observation_count": 0,
  "cashflow_event_count": 0,
  "gross_cash_in_usd": "...",
  "gross_cash_out_usd": "...",
  "non_position_income_neutralized_usd": "...",

  "max_abs_reconciliation_residual_usd": "...",
  "max_reconciliation_residual_ratio": "...",

  "candidate_rank": 0,
  "completed_episodes": 0,
  "raw_fill_count": 0,

  "quality": "PROVISIONAL|VERIFIED|APPROXIMATE|UNVERIFIABLE",
  "status": "ACTIVE|PASS|DROP|UNVERIFIABLE",
  "reason_code": null,
  "reason_message": null
}
```

## 17.3 output files

```text
reports/perp-twr-discovery/
  latest.json
  latest.md
  run-<timestamp>.json
  run-<timestamp>.md

reports/perp-twr-candidates/
  latest-top2000.json
  run-<timestamp>-top2000.json

state/perp-twr-top10/
  latest_active_top10.json

state/perp-twr-runs/
  <run_id>.checkpoint.json

state/perp-twr-discovery/
  cycle-state.json
  prior-leaderboard-addresses.json
```

canonical state 필수 필드:

```text
run_id
as_of_ms
metric_name
metric_version
coverage_mode
ranking_scope
window_start_ms
window_end_ms
wallets
config_hash
candidate_pool_hash
report_sha256
```

---

# 18. reason code 표준

```text
VALID
BELOW_MIN_ACCOUNT_VALUE

DISCOVERY_SIGNAL_UNAVAILABLE
DISCOVERY_POOL_INCOMPLETE
DISCOVERY_POOL_UNSTABLE
OUTSIDE_POOL_THRESHOLD_BREACH
FULL_DISCOVERY_REFRESH_INCOMPLETE

MISSING_PERP_MONTH
INSUFFICIENT_PORTFOLIO_SAMPLES
WINDOW_COVERAGE_INCOMPLETE
PORTFOLIO_ALIGNMENT_FAILED
PROVISIONAL_SCORING_FAILED

LEDGER_COVERAGE_INCOMPLETE
UNKNOWN_LEDGER_DELTA_TYPE
NON_USD_FLOW_UNPRICED
CASHFLOW_BOUNDARY_MISSING
EVENT_ORDER_AMBIGUOUS
RECONCILIATION_RESIDUAL_TOO_LARGE
NONPOSITIVE_CAPITAL_BASE
RETURN_BELOW_MINUS_100

LEDGER_VERIFICATION_POOL_EXHAUSTED
BOUNDARY_BREACH
BOUNDARY_UNSTABLE
INSUFFICIENT_VERIFIED_CANDIDATES
CANDIDATE_POOL_INCOMPLETE

HTTP_RETRY_EXHAUSTED
REQUEST_BUDGET_EXHAUSTED

FILL_10000_LIMIT
FILL_PAGINATION_INCOMPLETE
POSITION_CHAIN_DISCONTINUITY
FEWER_THAN_10_COMPLETED_EPISODES
INSUFFICIENT_FINALISTS

CANONICAL_UPDATE_BLOCKED
```

reason code와 사람이 읽는 message, 발생 stage를 함께 저장한다.

---

# 19. 권장 코드 변경 범위

## 19.1 Python screener

현재 `src/hyperliquid_whale_screener.py`를 분리하거나 최소한 책임별 함수로 나눈다.

권장 함수:

```python
load_leaderboard_universe()
compute_discovery_signals()
build_discovery_pool()
select_deterministic_rotating_sample()
calculate_provisional_perp_twr()
select_initial_ledger_verification_pool()
fetch_non_funding_ledger_updates()
classify_non_funding_delta()
align_perp_portfolio_samples()
calculate_verified_perp_twr()
run_boundary_probe()
expand_ledger_verification_pool_if_needed()
freeze_candidate_top2000()
reconstruct_completed_episodes()
validate_candidates_until_finalists()
write_canonical_state_if_complete()
```

권장 모듈:

```text
src/
  hyperliquid_whale_screener.py
  whale_lens/
    api.py
    discovery.py
    portfolio.py
    ledger.py
    twr.py
    episodes.py
    cache.py
    models.py
    report.py
```

필수 제거:

```python
eligible.sort(key=month_roi)
candidates = eligible[:500]
```

또는 동등한 단일 metric 선절단.

## 19.2 tests

권장:

```text
tests/
  test_episodes.py
  test_cashflows.py
  test_perp_twr.py
  test_discovery_pool.py
  test_candidate_pipeline.py
  test_resume_and_cache.py
  fixtures/
```

## 19.3 project docs

다음을 실제 코드와 함께 갱신한다.

```text
docs/workflows/daily-whale-screen.md
docs/file-map.md
AGENTS.md
CLAUDE.md
SKILL.md
skills/hyperliquid-whale-lens/SKILL.md
```

오래된 다음 표현을 제거한다.

```text
official ROI final ranking
candidate 500
20 completed episodes
MDD 40% mandatory
```

## 19.4 runner 연동

검토 파일:

```text
dashboard/app/seed-wallets.ts
dashboard/services/copy-runner/config.ts
dashboard/scripts/Local-CopyRunner.ps1
```

목표:

- canonical TOP 10이 source of truth
- 하드코딩 seed와 canonical state 불일치 감지
- stale run 자동 실행 금지
- config hash와 candidate pool hash 확인
- runner watchedWhales와 state wallets 일치 확인

---

# 20. CLI 제안

```text
python src/hyperliquid_whale_screener.py \
  --days 30 \
  --coverage-mode fast-incremental \
  --minimum-account-value 10000 \
  --leaderboard-roi-top 3000 \
  --leaderboard-pnl-top 2000 \
  --leaderboard-turnover-top 2000 \
  --prior-verified-top 2000 \
  --new-wallet-top 500 \
  --rotating-sample-count 500 \
  --discovery-pool-target 6000 \
  --discovery-pool-min 5000 \
  --discovery-pool-max 7000 \
  --ledger-verification-count 2500 \
  --ledger-expand-step 500 \
  --boundary-probe-count 100 \
  --candidate-count 2000 \
  --target-count 10 \
  --minimum-completed-episodes 10 \
  --ranking-metric perp-cashflow-neutral-twr \
  --fill-validation-mode until-10 \
  --strict-cashflow-boundaries \
  --resume
```

full discovery:

```text
python src/hyperliquid_whale_screener.py \
  --coverage-mode full-discovery-refresh \
  --days 30 \
  --ledger-verification-count 2500 \
  --candidate-count 2000 \
  --target-count 10 \
  --strict-cashflow-boundaries \
  --resume
```

legacy metric이 남는다면 명시적 옵션으로만 허용한다.

```text
--ranking-metric legacy-month-roi
```

기본값은 반드시 새 TWR이다.

---

# 21. 구현 검증 체크리스트

## 21.1 수익률 수학

- [ ] 입금만 발생한 `$1 → $101` 사례가 `0%`다.
- [ ] `$1 → $2` 수익 후 `$100` 입금 사례가 `100%`다.
- [ ] `$1`에 `$100` 입금 후 `$1` 수익 사례가 약 `0.990099%`다.
- [ ] 출금만 발생한 `$100 → $10` 사례가 `0%`다.
- [ ] 수익 후 출금이 출금 전 capital base로 계산된다.
- [ ] 출금 후 수익이 출금 후 equity를 capital base로 사용한다.
- [ ] 입금·출금 왕복이 자본을 중복 집계하지 않는다.
- [ ] +10%, +10%가 +21%다.
- [ ] -50%, +50%가 -25%다.
- [ ] -100% loss는 growth index 0이다.
- [ ] -100% 미만 interval은 오류다.
- [ ] Decimal을 사용한다.

## 21.2 `perpMonth`

- [ ] `month`가 아니라 `perpMonth`를 읽는다.
- [ ] `perpMonth`가 없으면 `month`로 fallback하지 않는다.
- [ ] month와 perpMonth가 다른 fixture에서 perpMonth만 따라간다.
- [ ] window coverage가 부족하면 제외한다.
- [ ] accountValue와 pnl timestamp alignment 실패를 숨기지 않는다.

## 21.3 ledger 분류

- [ ] 입금을 positive flow로 분류한다.
- [ ] 출금을 negative flow로 분류한다.
- [ ] spot ↔ perp 이동 부호가 맞다.
- [ ] master ↔ subaccount 방향이 맞다.
- [ ] vault deposit/withdraw 부호가 맞다.
- [ ] reward/commission이 neutralized flow다.
- [ ] unknown delta type은 UNVERIFIABLE이다.
- [ ] non-USDC valuation을 추측하지 않는다.
- [ ] 동일 event를 중복 반영하지 않는다.
- [ ] ledger pagination completeness를 검증한다.

## 21.4 정합성

- [ ] `equity_prev + delta_pnl + flow ≈ equity_current`를 검사한다.
- [ ] residual 초과 wallet을 제외한다.
- [ ] 큰 residual을 자동 입금으로 만들지 않는다.
- [ ] cash flow boundary가 없으면 strict mode에서 제외한다.
- [ ] event order가 모호하면 VERIFIED로 통과시키지 않는다.
- [ ] APPROXIMATE와 VERIFIED가 분리된다.
- [ ] APPROXIMATE wallet은 기본 candidate에 없다.

## 21.5 discovery pool

- [ ] leaderboard 전체를 읽는다.
- [ ] ROI 상위 3,000 버킷이 있다.
- [ ] PnL 상위 2,000 버킷이 있다.
- [ ] turnover 상위 2,000 버킷이 있다.
- [ ] prior verified TOP 2,000을 포함한다.
- [ ] 신규 지갑 최대 500명을 포함한다.
- [ ] rotating sample 500명이 deterministic하다.
- [ ] discovery pool이 5,000~7,000명이다.
- [ ] 같은 input에서 pool이 재현된다.
- [ ] 각 지갑 포함 이유가 저장된다.
- [ ] `eligible[:500]` 선절단이 제거됐다.
- [ ] month.roi 단독 2,000명 절단이 아니다.

## 21.6 provisional scoring

- [ ] discovery pool에만 portfolio를 조회한다.
- [ ] provisional metric이 별도 필드다.
- [ ] provisional quality가 PROVISIONAL이다.
- [ ] provisional 값으로 canonical state를 갱신할 수 없다.
- [ ] provisional TOP 2,500이 최초 ledger verification pool이다.

## 21.7 exact verification

- [ ] 최초 2,500명의 ledger를 검증한다.
- [ ] VERIFIED가 2,000명 미만이면 500명 단위로 확장한다.
- [ ] boundary probe 100명이 존재한다.
- [ ] probe cutoff breach 시 확장한다.
- [ ] boundary 불안정이면 canonical 갱신을 막는다.
- [ ] verified TOP 2,000을 freeze한다.
- [ ] candidate pool hash가 저장된다.
- [ ] candidate 순서가 deterministic하다.

## 21.8 에피소드

- [ ] aggregateByTime=false fills를 사용한다.
- [ ] partial entries는 한 에피소드다.
- [ ] partial exits는 0까지 한 에피소드다.
- [ ] reversal을 두 방향으로 분리한다.
- [ ] carry-in close는 count하지 않는다.
- [ ] still-open position은 count하지 않는다.
- [ ] HIP-3 perp를 포함한다.
- [ ] spot을 제외한다.
- [ ] 10,000-fill 한도는 UNVERIFIABLE이다.
- [ ] position discontinuity를 추정하지 않는다.
- [ ] completed episodes 10회 이상만 통과한다.

## 21.9 최종 TOP 10

- [ ] candidate rank 순서대로 fill을 검사한다.
- [ ] UNTIL_10 모드가 첫 10명에서 중단된다.
- [ ] final sort가 verified TWR 기준이다.
- [ ] MDD가 필수 필터가 아니다.
- [ ] absolute PnL로 재정렬하지 않는다.
- [ ] 10명 미만이면 가짜 10명을 만들지 않는다.
- [ ] ACTIVE가 정확히 최종 10명에게만 붙는다.

## 21.10 누락 감시

- [ ] rotating sample이 다음 cycle에서 진행된다.
- [ ] shard state가 persistent하다.
- [ ] 7~14일 full provisional coverage 목표를 추적한다.
- [ ] outside-pool cutoff breach를 감지한다.
- [ ] breach 발생 시 pool 확대 또는 canonical 갱신 보류가 작동한다.
- [ ] fast run을 global exact라고 표시하지 않는다.

## 21.11 cache와 resume

- [ ] 모든 요청이 같은 as_of를 사용한다.
- [ ] stage별 request budget이 있다.
- [ ] global weighted limiter가 있다.
- [ ] bounded retry다.
- [ ] raw data가 cache된다.
- [ ] cache key에 as_of와 metric version이 있다.
- [ ] 다른 날짜 score를 현재 final score로 재사용하지 않는다.
- [ ] 같은 run을 resume할 수 있다.
- [ ] discovery hash 변경 시 잘못된 cursor를 재사용하지 않는다.
- [ ] partial run이 canonical state를 덮어쓰지 않는다.
- [ ] atomic write를 사용한다.

## 21.12 보고서와 runner

- [ ] coverage mode와 ranking scope가 있다.
- [ ] discovery signal quota와 actual count가 있다.
- [ ] provisional/verified count가 있다.
- [ ] boundary probe/breach count가 있다.
- [ ] candidate hash가 있다.
- [ ] outside-pool breach count가 있다.
- [ ] wallet별 provisional과 verified TWR가 분리된다.
- [ ] candidate TOP 2,000 전체가 JSON에 있다.
- [ ] canonical state에 report/config/candidate hash가 있다.
- [ ] runner watchedWhales와 state wallets가 일치한다.
- [ ] stale state 자동 실행을 막는다.

---

# 22. 실제 데이터 수동 감사

## 22.1 입금 왜곡 지갑

- [ ] leaderboard month.roi가 비정상적으로 큰 지갑을 고른다.
- [ ] ledger에서 큰 입금·출금을 확인한다.
- [ ] 새 지표가 입금 자체를 수익으로 세지 않는지 수동 계산한다.
- [ ] 기존 metric과 새 metric 차이를 기록한다.

## 22.2 외부 flow가 없는 지갑

- [ ] 30일 외부 flow가 거의 없는 지갑을 고른다.
- [ ] 새 TWR가 단순 PnL/starting equity와 합리적으로 일치한다.
- [ ] reconciliation residual이 작다.
- [ ] quality가 VERIFIED다.

## 22.3 transfer가 많은 지갑

- [ ] spot/perp 또는 subaccount transfer가 여러 번 있는 지갑을 고른다.
- [ ] 각 방향과 부호를 수동 확인한다.
- [ ] flow 전후 capital base를 확인한다.
- [ ] withdrawal-to-dust가 과장 수익률을 만들지 않는다.

## 22.4 outside-pool breach

- [ ] discovery pool 밖 fixture를 만든다.
- [ ] 그 지갑의 score가 current cutoff보다 높게 설정된다.
- [ ] threshold breach가 감지된다.
- [ ] discovery 확대 또는 canonical 갱신 보류가 작동한다.

---

# 23. 완료 조건

다음을 모두 만족해야 완료다.

1. `perpMonth`만 성과 period로 사용한다.
2. non-funding ledger로 입출금을 보정한다.
3. 입금만으로 수익률이 증가하지 않는다.
4. 기존 ROI 상위 500 선절단이 제거됐다.
5. 다중 신호로 discovery pool 5,000~7,000명을 만든다.
6. discovery pool 전체에 provisional perp TWR을 계산한다.
7. provisional 상위 2,500명부터 ledger 검증한다.
8. 부족하거나 boundary가 불안정하면 500명 단위로 확장한다.
9. verified TWR 상위 2,000명을 freeze한다.
10. raw fills를 candidate 순서대로 검사한다.
11. 10 completed episodes 조건의 첫 10명을 ACTIVE로 정한다.
12. rotating sample과 shard refresh가 있다.
13. fast run을 global exact라고 과장하지 않는다.
14. 불완전 데이터는 reason code와 함께 제외한다.
15. unit/integration tests가 통과한다.
16. run resume가 가능하다.
17. partial run은 canonical state를 덮어쓰지 않는다.
18. runner가 canonical TOP 10을 실제 사용한다.
19. 문서와 코드가 일치한다.
20. 실제 입금 왜곡 지갑 감사 결과가 계산과 일치한다.

---

# 24. 개발 에이전트 최종 제출 형식

```markdown
## 변경 요약

## 변경 파일

## 최종 TWR 계산식

## cash-flow delta type 매핑표

## discovery pool 5,000~7,000명 생성 방법
- ROI bucket:
- PnL bucket:
- turnover bucket:
- prior verified:
- new wallets:
- rotating sample:
- actual unique count:

## provisional TOP 2,500 생성 방법

## ledger verification 확장과 boundary probe 결과

## verified candidate TOP 2,000 생성 방법

## completed episode 검증 방법

## 테스트 결과
- Python unit tests:
- integration tests:
- real-wallet audit:
- outside-pool breach test:

## 생성된 run
- run_id:
- as_of:
- coverage_mode:
- ranking_scope:
- eligible universe:
- discovery pool:
- provisional scored:
- ledger verified:
- candidate count:
- fills scanned:
- finalists:

## 데이터 품질 이슈
- unknown ledger types:
- ledger coverage failures:
- cash-flow boundary failures:
- reconciliation failures:
- incomplete fills:
- HTTP failures:

## canonical TOP 10과 runner 동기화 상태

## 이전 방식과 결과 차이

## 남은 위험
```

---

# 25. 구현 시 특히 주의할 함정

1. candidate-limit 숫자만 2,000으로 바꾸지 않는다.
2. month.roi 상위 2,000명을 최종 후보로 쓰지 않는다.
3. discovery pool을 ROI 하나로 만들지 않는다.
4. 모든 적격 지갑을 매일 정밀 계산하지 않는다.
5. provisional TWR을 verified final metric으로 표시하지 않는다.
6. verified 2,000명 미만인데 candidate complete로 표시하지 않는다.
7. boundary probe 없이 2,500→2,000 경계가 안전하다고 가정하지 않는다.
8. fast result를 global exact라고 주장하지 않는다.
9. funding과 fee를 perpMonth에 이중 반영하지 않는다.
10. unknown ledger type을 0원 flow로 처리하지 않는다.
11. 큰 residual을 자동 입금으로 만들지 않는다.
12. ambiguous event order를 VERIFIED로 통과시키지 않는다.
13. 예전 window의 episode count를 새 window에 재사용하지 않는다.
14. 높은 수익률을 임의 cap하지 않는다.
15. prior score를 현재 final score로 재사용하지 않는다.
16. nondeterministic random sample을 사용하지 않는다.
17. partial run이 latest state를 덮어쓰지 않는다.
18. GitHub mirror와 실제 실행 worktree 중 어디를 수정했는지 기록한다.

---

# 26. 최종 데이터 흐름

```text
Hyperliquid leaderboard 전체
        │
        ├─ minimum account value
        ├─ month ROI rank ───────────────┐
        ├─ month absolute PnL rank ──────┤
        ├─ month turnover rank ──────────┤
        ├─ prior verified TOP 2,000 ─────┤
        ├─ new eligible wallets ─────────┤
        └─ rotating outside-pool sample ─┘
                         │
                         ▼
       deterministic discovery pool 5,000~7,000
                         │
                         ▼
             portfolio.perpMonth
                         │
                         ▼
        inferred-flow provisional perp TWR
                         │
                         ▼
              provisional TOP 2,500
                         │
                         ▼
        userNonFundingLedgerUpdates
                         │
                         ▼
       strict cash-flow classification
                         │
                         ▼
       verified cash-flow-neutral perp TWR
                         │
            ┌────────────┴────────────┐
            │ VERIFIED < 2,000       │ boundary breach
            ▼                         ▼
      next 500 verification      next 500 verification
            └────────────┬────────────┘
                         ▼
          verified TWR TOP 2,000 freeze
                         │
                         ▼
       raw fills validation in candidate rank order
                         │
                         ▼
             completed episodes >= 10
                         │
                         ▼
             first qualifying ACTIVE TOP 10
                         │
                         ▼
 canonical state + report + runner validation
                         │
                         ▼
 rotating shard and threshold-breach feedback
```

이 구조의 최종 목표:

> 입출금으로 부풀려진 ROI가 아니라, perpetual 포지션 거래로 실제 얻은 최근 30일 입출금 보정 복리수익률이 높고, 같은 기간 완결 포지션 거래가 10회 이상인 지갑 10명을 카피 대상으로 선정한다.
