# 30D TWR 상위 체결 보유 지갑 10명 — 90일 활동 분석

- 생성 시각: `2026-08-21T08:13:14.804591+00:00`
- 고정 90일 구간: `2026-05-23T07:53:29.183000+00:00` ~ `2026-08-21T07:53:29.183000+00:00`
- 선정: VERIFIED 30D 입출금 중립 TWR 순서를 유지하고 최근 30일 raw fill이 1건 이상인 첫 10명
- 완료 포지션: `aggregateByTime=false` 원본 체결의 0 → non-zero → 0만 집계; 10,000-fill 제한/불연속은 미확정
- 90일 체결 완전 수집: **4/10명**; 나머지는 행별 제한 사유를 보존

|활동순위|원 후보순위|지갑|30D TWR|현재 퍼프 계좌가치|90D fills|90D 완료 포지션|활성일|현재 포지션|상태|
|---:|---:|---|---:|---:|---:|---:|---:|---:|---|
|1|2|`0x793348…765ac9`|+175.87%|$19,649.50|37|1|2|1|완전|
|2|5|`0xa45ee3…e0cfb9`|+132.86%|$60,874.51|3,159|미확정|55|2|POSITION_CHAIN_DISCONTINUITY|
|3|8|`0x15a4f0…e0dfdb`|+117.01%|$22,338,807.77|3,866|0|7|2|완전|
|4|17|`0xb64460…977d51`|+89.23%|$467,048.81|1,737|4|16|1|완전|
|5|33|`0x8804e9…150df6`|+75.88%|$94,475.64|0|미확정|0|0|FILL_PAGINATION_INCOMPLETE|
|6|45|`0xcec62a…ea715f`|+69.41%|$119,333.98|0|미확정|0|0|FILL_PAGINATION_INCOMPLETE|
|7|46|`0x1dacfa…eb2430`|+69.34%|$8,788.90|0|미확정|0|2|FILL_PAGINATION_INCOMPLETE|
|8|51|`0x480804…21a82c`|+68.40%|$408,777.59|0|미확정|0|1|FILL_PAGINATION_INCOMPLETE|
|9|87|`0x639c8d…8a9aa9`|+50.94%|$46,239.66|0|미확정|0|1|FILL_PAGINATION_INCOMPLETE|
|10|99|`0xf8b5bd…15e2bb`|+47.29%|$1,238,828.96|0|미확정|0|34|FILL_PAGINATION_INCOMPLETE|

## 1. 후보 2위 — `0x7933481da364d5cc3151c22154a0295703765ac9`

- 30D 입출금 중립 TWR: **+175.87%**
- 선별시 총 계좌가치: **$12,232.66**
- 현재 전체 DEX 퍼프 계좌가치: **$19,649.50** (WebSocket 스냅샷)
- 90D raw fills/활성일: **37건 / 2일**
- 90D 완료 포지션: **1**
- 주 거래 코인: XRP(35), xyz:BRENTOIL(2)
- taker 체결 비율: +5.41%
- 현재 포지션: XRP LONG 20x
- 마지막 체결: `2026-08-20T09:07:41.448000+00:00`

## 2. 후보 5위 — `0xa45ee34298f8e5596fef0870a42f80182de0cfb9`

- 30D 입출금 중립 TWR: **+132.86%**
- 선별시 총 계좌가치: **$62,888.95**
- 현재 전체 DEX 퍼프 계좌가치: **$60,874.51** (WebSocket 스냅샷)
- 90D raw fills/활성일: **3,159건 / 55일**
- 90D 완료 포지션: **미확정**
- 주 거래 코인: SOL(1156), HYPE(902), ETH(113)
- taker 체결 비율: +97.91%
- 현재 포지션: HYPE LONG 10x, SOL SHORT 20x
- 마지막 체결: `2026-08-20T00:20:16.901000+00:00`
- 검증 제한: `POSITION_CHAIN_DISCONTINUITY` — position discontinuity for SOL: expected 0, got 685.53

## 3. 후보 8위 — `0x15a4f009bb324a3fb9e36137136b201e3fe0dfdb`

- 30D 입출금 중립 TWR: **+117.01%**
- 선별시 총 계좌가치: **$19,849,471.72**
- 현재 전체 DEX 퍼프 계좌가치: **$22,338,807.77** (WebSocket 스냅샷)
- 90D raw fills/활성일: **3,866건 / 7일**
- 90D 완료 포지션: **0**
- 주 거래 코인: BTC(2425), ETH(626), @151(815)
- taker 체결 비율: +97.23%
- 현재 포지션: BTC LONG 40x, ETH LONG 20x
- 마지막 체결: `2026-07-25T00:00:00.066000+00:00`

## 4. 후보 17위 — `0xb64460b8f4a2f521b815a209f053d35fb1977d51`

- 30D 입출금 중립 TWR: **+89.23%**
- 선별시 총 계좌가치: **$404,669.76**
- 현재 전체 DEX 퍼프 계좌가치: **$467,048.81** (WebSocket 스냅샷)
- 90D raw fills/활성일: **1,737건 / 16일**
- 90D 완료 포지션: **4**
- 주 거래 코인: SOL(629), ETH(161), XMR(703)
- taker 체결 비율: +57.05%
- 현재 포지션: SOL LONG 20x
- 마지막 체결: `2026-08-01T18:47:03.108000+00:00`

## 5. 후보 33위 — `0x8804e9fda107be1424e355f5e2652b559d150df6`

- 30D 입출금 중립 TWR: **+75.88%**
- 선별시 총 계좌가치: **$94,475.64**
- 현재 전체 DEX 퍼프 계좌가치: **$94,475.64** (WebSocket 스냅샷)
- 90D raw fills/활성일: **0건 / 0일**
- 90D 완료 포지션: **미확정**
- 주 거래 코인: 없음
- taker 체결 비율: —
- 현재 포지션: 없음
- 마지막 체결: `—`
- 검증 제한: `FILL_PAGINATION_INCOMPLETE` — raw-fill pagination cannot prove complete coverage of the evaluation window
- 수집 제한: `HTTP_RETRY_EXHAUSTED: request to https://api.hyperliquid.xyz/info failed after 4 attempt(s): retryable HTTP 429`

## 6. 후보 45위 — `0xcec62a8b313740495cc2d6f5728f2f978fea715f`

- 30D 입출금 중립 TWR: **+69.41%**
- 선별시 총 계좌가치: **$119,333.98**
- 현재 전체 DEX 퍼프 계좌가치: **$119,333.98** (WebSocket 스냅샷)
- 90D raw fills/활성일: **0건 / 0일**
- 90D 완료 포지션: **미확정**
- 주 거래 코인: 없음
- taker 체결 비율: —
- 현재 포지션: 없음
- 마지막 체결: `—`
- 검증 제한: `FILL_PAGINATION_INCOMPLETE` — raw-fill pagination cannot prove complete coverage of the evaluation window
- 수집 제한: `HTTP_RETRY_EXHAUSTED: request to https://api.hyperliquid.xyz/info failed after 4 attempt(s): retryable HTTP 429`

## 7. 후보 46위 — `0x1dacfab213f593420639805d6f697f992eeb2430`

- 30D 입출금 중립 TWR: **+69.34%**
- 선별시 총 계좌가치: **$19,525.63**
- 현재 전체 DEX 퍼프 계좌가치: **$8,788.90** (WebSocket 스냅샷)
- 90D raw fills/활성일: **0건 / 0일**
- 90D 완료 포지션: **미확정**
- 주 거래 코인: 없음
- taker 체결 비율: —
- 현재 포지션: xyz:DRAM SHORT 20x, xyz:SKHX LONG 10x
- 마지막 체결: `—`
- 검증 제한: `FILL_PAGINATION_INCOMPLETE` — raw-fill pagination cannot prove complete coverage of the evaluation window
- 수집 제한: `HTTP_RETRY_EXHAUSTED: request to https://api.hyperliquid.xyz/info failed after 4 attempt(s): retryable HTTP 429`

## 8. 후보 51위 — `0x48080441105eff197da409c154608c3e9021a82c`

- 30D 입출금 중립 TWR: **+68.40%**
- 선별시 총 계좌가치: **$372,162.35**
- 현재 전체 DEX 퍼프 계좌가치: **$408,777.59** (WebSocket 스냅샷)
- 90D raw fills/활성일: **0건 / 0일**
- 90D 완료 포지션: **미확정**
- 주 거래 코인: 없음
- taker 체결 비율: —
- 현재 포지션: DOGE LONG 3x
- 마지막 체결: `—`
- 검증 제한: `FILL_PAGINATION_INCOMPLETE` — raw-fill pagination cannot prove complete coverage of the evaluation window
- 수집 제한: `HTTP_RETRY_EXHAUSTED: request to https://api.hyperliquid.xyz/info failed after 4 attempt(s): retryable HTTP 429`

## 9. 후보 87위 — `0x639c8d8744f66b1cf9ff9a5776d92b9e498a9aa9`

- 30D 입출금 중립 TWR: **+50.94%**
- 선별시 총 계좌가치: **$46,445.51**
- 현재 전체 DEX 퍼프 계좌가치: **$46,239.66** (WebSocket 스냅샷)
- 90D raw fills/활성일: **0건 / 0일**
- 90D 완료 포지션: **미확정**
- 주 거래 코인: 없음
- taker 체결 비율: —
- 현재 포지션: HYPE LONG 2x
- 마지막 체결: `—`
- 검증 제한: `FILL_PAGINATION_INCOMPLETE` — raw-fill pagination cannot prove complete coverage of the evaluation window
- 수집 제한: `HTTP_RETRY_EXHAUSTED: request to https://api.hyperliquid.xyz/info failed after 4 attempt(s): retryable HTTP 429`

## 10. 후보 99위 — `0xf8b5bde5f6aa989c01754931e077e1e5a915e2bb`

- 30D 입출금 중립 TWR: **+47.29%**
- 선별시 총 계좌가치: **$1,192,333.83**
- 현재 전체 DEX 퍼프 계좌가치: **$1,238,828.96** (WebSocket 스냅샷)
- 90D raw fills/활성일: **0건 / 0일**
- 90D 완료 포지션: **미확정**
- 주 거래 코인: 없음
- taker 체결 비율: —
- 현재 포지션: xyz:XYZ100 LONG 15x, xyz:SPCX LONG 10x, xyz:MSFT LONG 10x, xyz:SP500 LONG 15x, xyz:AMZN LONG 10x
- 마지막 체결: `—`
- 검증 제한: `FILL_PAGINATION_INCOMPLETE` — raw-fill pagination cannot prove complete coverage of the evaluation window
- 수집 제한: `HTTP_RETRY_EXHAUSTED: request to https://api.hyperliquid.xyz/info failed after 4 attempt(s): retryable HTTP 429`

## 해석 주의

높은 30D TWR는 90D 반복 매매 횟수와 같은 뜻이 아닙니다. 완료 포지션 미확정 지갑은 승률·에피소드 손익을 추정하지 않았습니다.
