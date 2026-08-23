---
name: hyperliquid-30d-whale-screener
description: Hyperliquid 공개 데이터로 최근 30일 perpetual 입출금 중립 TWR 상위 카피트레이딩 후보를 선별하고, TOP2000·활성 TOP10·재개 체크포인트를 저장한다. Whale Lens 고래 재선별, 입출금 보정 수익률, TOP10 갱신, 모의투자 대상 산정에 사용한다.
---

# Hyperliquid 30D Whale Screener

## 불변 규칙

- 현재 계좌가치가 `$10,000` 이상인 지갑만 다룬다.
- 최종 지표는 `perp_cashflow_neutral_twr_30d` 하나다. leaderboard `month.roi`는 탐색 신호일 뿐 최종 점수가 아니다.
- `portfolio.perpMonth`만 사용하고 `userNonFundingLedgerUpdates`로 입금·출금·이체·vault 이동·비거래 보상을 중립화한다.
- 모든 지갑은 run-wide 고정 30일 구간으로 clip하고 그 안의 실제 aligned sample만 사용한다. 바깥의 가까운 샘플을 정확한 경계로 재표기하거나 큰 간격을 보간하지 않으며, 구간 안에 sample이 2개 미만이면 제외한다.
- cash flow는 현재 경계의 계좌가치 정합성에만 반영하고 다음 구간 자본을 바꾼다. 구간 수익률은 `Δpnl / previous account value`, 최종값은 `Π(1+r)-1`이다.
- unknown/non-USD ledger type, 누락된 cash-flow 경계, 큰 reconciliation residual, 비양수 자본, 불완전 pagination은 `UNVERIFIABLE`이다.
- MDD는 진단값이며 기본 탈락 조건이 아니다.
- ACTIVE 활동 증거는 `userFillsByTime`의 `aggregateByTime:false` perpetual 원본 체결 1건 이상이다. 이미 관측한 체결은 전체 페이지가 불완전해도 양성 활동 증거로 인정하되 정확한 체결 수라고 주장하지 않는다.
- `0 → non-zero → 0` 완료 episode와 episode PnL은 선택·정렬·위험·카피 적합성 판단에서 제외한다. 필요하면 참고 진단으로만 계산한다.

## 기본 파이프라인

1. 전체 leaderboard에서 ROI 3000, PnL 2000, turnover 2000, prior verified 2000, new 500, rotating 500을 deterministic RRF로 합쳐 5,000~7,000명(목표 6,000)을 만든다. A~E 밖의 persistent outside shard 1,000명도 전원 provisional 평가하며, 500명 rotating quota는 중복 제거 뒤 deterministic backfill한다.
2. discovery pool 전체의 `perpMonth` provisional TWR을 계산한다.
3. provisional 상위 2,500명부터 ledger 검증하고, VERIFIED 2,000명 또는 안정된 경계를 얻을 때까지 500명씩 확장한다. 매 경계마다 deterministic 100명 probe를 수행한다.
4. verified TWR 상위 2,000명을 hash와 함께 freeze한다.
5. candidate 순서대로 raw fills를 검사해 관측된 perpetual 원본 체결이 1건 이상인 첫 10명을 `ACTIVE`로 정한다. 완료 episode 수는 보지 않는다.

`FAST_INCREMENTAL` 결과의 범위는 `DISCOVERY_POOL_EXACT`다. 전체 적격 지갑을 provisional scan한 `FULL_DISCOVERY_REFRESH`만 전 우주 범위로 표시한다.

## 실행과 저장

프로젝트 루트에서 먼저 테스트하고 실행한다.

```powershell
python -m unittest discover -s tests -v
python src\hyperliquid_whale_screener.py --resume
```

주요 출력:

- `reports/perp-twr-discovery/latest.json|md`와 timestamp run 파일
- `reports/perp-twr-candidates/latest-top2000.json`과 run 파일
- `state/perp-twr-top10/latest_active_top10.json`
- `state/perp-twr-runs/<run>.checkpoint.json`
- `state/perp-twr-discovery/cycle-state.json`

partial run, VERIFIED 2,000명 미달, boundary breach, outside shard 평가 누락, finalist 10명 미달, report/hash 불일치는 기존 canonical TOP10을 덮어쓰지 못한다. copy runner는 보고서·candidate hash까지 교차 검증된 canonical TOP10만 사용해야 한다.

사용자가 현재 턴에 명시적으로 허용한 경우에만, 완전한 고정-window `perp-month-simple-twr` TOP10을 별도 SIMULATION 연구 세션에 사용할 수 있다. 전체 보고서에서 TOP10을 독립 재산출하고 compact state와 보고서 파일 hash를 교차검증하며, `NEW_POSITIONS_ONLY`로 기존 포지션·과거 체결은 제외하고 현재 진입 가능한 미체결 주문만 시작 스냅샷에 복제한다. 이 예외는 canonical 또는 live 입력이 아니다.

## 운영 경계

- Hyperliquid endpoint weight를 합산한 global 1,200 weight/min limiter와 stage별 budget을 유지한다.
- 429/5xx는 bounded exponential backoff만 사용하고 무한 재시도하지 않는다.
- 새 프로세스의 global limiter는 토큰 0에서 warm start해 직전 프로세스의 rolling quota와 초기 burst가 겹치지 않게 한다.
- cache key에 wallet, endpoint, fixed window, as-of, metric/schema version, coverage mode를 모두 넣는다.
- 로컬 모의투자가 실행 중이면 새 canonical이 완전히 확정되기 전 재시작하지 않는다. 실전 주문 기능은 별도 명시 없이는 활성화하지 않는다.
