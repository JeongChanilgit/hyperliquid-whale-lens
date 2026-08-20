---
name: hyperliquid-30d-whale-screener
description: Hyperliquid 공개 데이터로 최근 30일 입출금 보정 ROI 상위 카피트레이딩 후보를 선별한다. 현재 자산 $10k 이상 → 공식 cashflow-adjusted 30D ROI 순 → 완료 포지션 episode 10회 이상 → 입출금 중립 포트폴리오 MDD 40% 미만 → 상위 30과 활성 상위 10을 출력한다.
---

# Hyperliquid 30D Whale Screener

## 현재 규칙

- 현재 계좌가치: **$10,000 이상**
- 최종 ROI: Hyperliquid leaderboard의 공식 `month.roi`
  - Hyperliquid portfolio PnL은 입금·출금을 보정한다.
  - 과거의 `completed net PnL / first non-zero balance` 방식은 사용하지 않는다.
- 최근 30일 완료 거래: **20 episode 이상**
- 포트폴리오 MDD: **40% 미만** (`MDD >= 40%` 탈락)
- 최종 순위: **입출금 보정 공식 30D ROI 내림차순**
- 최종 상위 30명 중 상위 10명을 `ACTIVE`로 표시한다.

## 거래 횟수 정의

분할체결, 추가진입, 부분청산을 각각 거래로 세지 않는다. 코인별 signed position이 아래 경로를 완성해야 1회다.

```text
0 → non-zero → 0 = 1 completed episode
```

- 방향 반전으로 한 fill에서 0을 통과하면 기존 episode 종료 후 반대 방향 episode가 시작된다.
- 진입과 최종 청산이 모두 최근 30일 창 안에 있어야 한다.
- 30일 전에 열린 포지션과 아직 열린 포지션은 완료 횟수에서 제외한다.
- 모든 코인의 완료 episode 합이 20 미만이면 탈락한다.

## 데이터 소스

- Public leaderboard: `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard`
  - `ethAddress`, `accountValue`, `windowPerformances.month.roi/pnl/vlm`
- Hyperliquid Info API: `POST https://api.hyperliquid.xyz/info`
  - `portfolio`: `month.accountValueHistory`, `month.pnlHistory`
  - `userFillsByTime`: 최근 30일 체결, `aggregateByTime: true`
  - 원본 체결 완전성 확인은 `aggregateByTime: false`

## 선별 순서

1. leaderboard에서 현재 `accountValue >= $10,000`만 남긴다.
2. 공식 `month.roi` 내림차순으로 정렬한다.
3. 상위 후보를 순서대로 최대 500명 정밀 검증한다.
4. `userFillsByTime`으로 코인별 episode를 복원한다.
5. 완료 episode가 10회 미만이면 탈락한다.
6. 최근 10,000 fills 제한 때문에 전체 데이터를 복원할 수 없으면 `UNVERIFIABLE`이다.
7. portfolio PnL/account-value 곡선에서 입출금 변화 구간을 분리한 MDD를 계산한다.
8. MDD가 40% 이상이면 탈락한다.
9. 공식 입출금 보정 ROI 순으로 상위 30명을 출력하고 상위 10명을 활성 후보로 표시한다.

## 입출금 보정 원칙

Hyperliquid의 portfolio PnL은 account value와 순입출금으로 계산되므로 leaderboard `month.roi`를 공식 입출금 보정 수익률로 사용한다. 첫 잔고가 극소액인 지갑에 이후 큰 입금이 있어도 극소 잔고를 분모로 나누지 않는다.

MDD에서는 연속된 account value/PnL 표본 사이의 외부자금 변화를 다음처럼 추론한다.

```text
inferred_flow = Δaccount_value - Δpnl
```

- 입금 구간은 입금 후 자본을 수익률 분모로 사용한다.
- 출금 구간은 출금 전 자본을 분모로 사용한다.
- 구간 수익률을 연결한 cashflow-neutral equity index에서 MDD를 구한다.
- 이 방식은 열린 포지션, 미실현 PnL, funding이 반영되는 portfolio 곡선을 사용한다.

## Episode 데이터 품질 규칙

- `aggregateByTime: true`를 사용하되 동일 millisecond의 API 응답 순서를 유지한다.
- `startPosition` 연결 관계를 검증하며 `tid`로 재정렬하지 않는다.
- 분할매수·분할매도·부분청산은 같은 episode에 누적한다.
- 한 fill에서 방향 반전 시 수수료를 청산/신규 수량 비율로 나눈다.
- `abs(position) <= 1e-9`만 산술 dust로 0 처리한다.
- 완료 spot episode, 비-USDC 수수료, 포지션 불연속, 10,000 fills 범위 초과는 추정하지 않고 `UNVERIFIABLE`로 처리한다.
- 완료 episode net PnL은 진단 정보일 뿐 최종 ROI 순위의 분자가 아니다.

## 출력

| Rank | Wallet | Account Value | Cashflow-adjusted 30D ROI | Completed Episodes | Portfolio MDD | Completed Net PnL | Main Coins | Status |
|---:|---|---:|---:|---:|---:|---:|---|---|

- `ACTIVE`: 최종 1~10위
- `PASS`: 최종 11~30위
- `DROP`: 자산·횟수·MDD 조건 탈락
- `UNVERIFIABLE`: 원천 데이터로 정확히 검증 불가

30명을 억지로 채우지 않는다. 검증 통과자가 30명보다 적으면 그 수만 출력한다.

## 일일 운영

매 실행마다 rolling 30일 창을 새로 계산하고 이전 ACTIVE TOP 10과 `NEW/OUT/UP/DOWN/SAME`을 비교한다. 원천 데이터를 정확히 조회할 수 없으면 수치를 추정하지 않는다.
