# Codex 인수인계 명세 — Five-Whale Faithful Mirror V2 통합·검증

**저장소:** `JeongChanilgit/hyperliquid-whale-lens`  
**작성 기준일:** 2026-08-24 KST  
**목표:** 최대 5명의 Hyperliquid 고래를 각각 독립 follower 계정에 연결하여, PAPER와 LIVE가 같은 상태 미러링 코어를 사용하는 실행 가능한 서비스를 완성한다.  
**중요:** 이 문서는 현재 GitHub 원격 상태를 다시 확인한 뒤 작성한 작업 기준서다. 이전 대화에서 “완료·테스트 통과·PR 생성”이라고 언급된 내용은 원격에서 확인되지 않았으므로 그대로 믿지 말고 아래 검증 순서를 따른다.

---

## 0. Codex에 전달할 핵심 지시

다음 문장을 작업의 최상위 원칙으로 사용한다.

> `feature/five-whale-faithful-mirror-v2-final`의 기존 코어를 보존하면서 누락된 실행 진입점·설정 로더·서명 브리지·제어 서버·재시작 복구를 통합한다. 최대 추적 고래 수는 5명이며, 각 고래는 서로 다른 target subaccount를 사용한다. PAPER와 LIVE는 같은 `FiveWhaleFaithfulMirrorEngine` 및 `FaithfulPairActor`를 사용한다. 시작 시 고래의 현재 포지션을 현재 시장가로 동기화하고, 기존 미체결 주문을 동일 속성으로 축소 복제한다. 이후 source 주문 create/modify/cancel을 즉시 shadow하고, source의 모든 fill을 debounce 없이 즉시 목표 포지션 변경 트리거로 사용한다. LIVE mainnet 주문은 Codex 작업 중 절대 보내지 않는다.

---

# 1. 현재 원격 저장소의 실제 상태

## 1.1 기준 브랜치

스크리너와 기존 프로젝트 개발 기준:

```text
feature/verified-perp-twr-pipeline
```

확인 당시 기준 커밋:

```text
31e8206afcb9f5f3fe822c7822114f8294324204
```

## 1.2 Faithful Mirror 관련 브랜치

### `feature/five-whale-faithful-mirror-v2-final`

가장 많은 구현이 있는 브랜치다.

```text
feature/verified-perp-twr-pipeline 대비 20 commits ahead
```

추가된 주요 파일:

```text
dashboard/services/faithful-mirror-v2/
  .env.example
  .gitignore
  audit-store.mjs
  config.example.json
  domain.mjs
  domain.test.mjs
  engine.mjs
  engine.test.mjs
  live-port.mjs
  live-port.test.mjs
  package.json
  pair-actor.mjs
  pair-actor.test.mjs
  paper-runtime.mjs
  paper-runtime.test.mjs
  paper-venue.mjs
  paper-venue.test.mjs
  requirements.txt
  runtime.mjs
  runtime.test.mjs
```

이 브랜치를 **통합 작업의 기준 브랜치**로 사용한다.

### `feature/five-whale-faithful-mirror-v2`

별도의 초기 구현이 있는 분기 브랜치다.

```text
feature/verified-perp-twr-pipeline 대비 3 commits ahead
```

추가된 주요 파일:

```text
config.mjs
config.test.mjs
domain.mjs
domain.test.mjs
engine.mjs
env.example
pair-actor.mjs
pair-actor.test.mjs
requirements.txt
start.mjs
store.mjs
```

주의:

```text
start.mjs
→ "./service.mjs"를 import
→ 해당 service.mjs는 브랜치에 없음
```

따라서 이 브랜치를 통째로 merge 또는 cherry-pick하지 않는다. `config.mjs`, `store.mjs`의 아이디어만 비교·선별 이식한다.

### `feature/five-whale-faithful-mirror-v2-complete`

이름과 달리 구현이 없다.

```text
feature/verified-perp-twr-pipeline과 동일
ahead 0 / behind 0
```

사용하지 않는다.

## 1.3 현재 `v2-final`의 실행 불가 원인

`package.json`은 다음을 실행하도록 되어 있다.

```json
{
  "start": "node index.mjs",
  "check": "node --check index.mjs ... && python -m py_compile hyperliquid_pair_bridge.py"
}
```

그러나 원격 브랜치에는 다음 파일이 없다.

```text
index.mjs
hyperliquid_pair_bridge.py
README.md
```

또한 독립적인 authoritative config loader와 HTTP control server가 없다.

현재 상태에서:

```text
npm start
→ index.mjs 누락으로 실패

npm run check
→ index.mjs 또는 hyperliquid_pair_bridge.py 누락으로 실패

LIVE
→ signer bridge 누락으로 실패
```

## 1.4 PR·CI 상태

Faithful Mirror V2 관련 PR은 확인되지 않았다.

```text
open PR 없음
closed PR 없음
확인 가능한 CI 결과 없음
```

기존 테스트 파일이 존재한다는 사실과 clean clone에서 서비스 전체가 통과했다는 것은 다른 주장이다. 완료 판정은 반드시 새 통합 브랜치에서 다시 수행한다.

---

# 2. 작업 브랜치 전략

## 2.1 권장 명령

```bash
git fetch origin --prune

git checkout feature/five-whale-faithful-mirror-v2-final
git pull --ff-only

git checkout -b feature/five-whale-faithful-mirror-v2-integrated
```

이미 같은 이름의 작업 브랜치가 있으면 새 이름을 사용한다.

```text
feature/five-whale-faithful-mirror-v2-integrated-2
```

## 2.2 금지 사항

다음을 하지 않는다.

```text
- feature/five-whale-faithful-mirror-v2-complete를 기준으로 작업
- 초기 v2 브랜치를 통째로 merge
- 서로 다른 domain.mjs, engine.mjs, pair-actor.mjs를 자동 충돌 해결
- 기존 dashboard/services/copy-runner를 삭제하거나 대체
- 기존 모의투자 SQLite 및 상태 파일을 새 서비스에서 재사용
- main에 직접 커밋
- mainnet 주문 전송
```

## 2.3 초기 브랜치에서 참고할 파일

아래 파일은 비교 후 필요한 부분만 수동 이식한다.

```text
origin/feature/five-whale-faithful-mirror-v2:
  dashboard/services/faithful-mirror-v2/config.mjs
  dashboard/services/faithful-mirror-v2/config.test.mjs
  dashboard/services/faithful-mirror-v2/store.mjs
```

`start.mjs`는 구조 참고만 하고 그대로 복사하지 않는다.

---

# 3. 최종 목표 디렉터리

완료 시 최소 구성:

```text
dashboard/services/faithful-mirror-v2/
  README.md
  package.json
  requirements.txt

  index.mjs
  config.mjs
  control-server.mjs

  domain.mjs
  pair-actor.mjs
  engine.mjs

  runtime.mjs
  paper-runtime.mjs
  paper-venue.mjs
  live-port.mjs
  hyperliquid_pair_bridge.py

  audit-store.mjs

  config.example.json
  .env.example
  .gitignore

  domain.test.mjs
  pair-actor.test.mjs
  engine.test.mjs
  runtime.test.mjs
  paper-runtime.test.mjs
  paper-venue.test.mjs
  live-port.test.mjs

  config.test.mjs
  control-server.test.mjs
  index.integration.test.mjs
  signer-contract.test.mjs
  restart-recovery.test.mjs
```

파일을 더 나누는 것은 허용하지만, 책임은 위 구조와 동등하게 분리한다.

---

# 4. 기능 범위

## 4.1 반드시 구현

```text
- 최대 5개의 source-target pair
- 고래별 독립 target account/subaccount
- PAPER와 LIVE의 공통 상태 미러링 코어
- 시작 시 현재 포지션을 현재 시장가로 동기화
- Cross/isolated mode 및 source leverage 복제
- Isolated margin 비율 복제
- 기존 open order 전부 shadow
- source order create/modify/cancel 즉시 반영
- source fill마다 즉시 target-position reconciliation
- 처리 중 들어온 fill을 latest-state 방식으로 병합
- 250ms 및 1,000ms residual 검증
- reconnect fill backfill
- target 실제 상태 기반 재조정
- durable audit와 restart checkpoint
- PAPER realistic execution
- LIVE arm gate 및 mainnet 이중 확인
- clean-clone 테스트
```

## 4.2 이번 버전에서 명시적으로 미지원

```text
- Portfolio Margin source 또는 target
- 서로 다른 고래가 같은 target account 공유
- 고래 과거 entry price 및 과거 미실현 PnL 소급
- source와 target의 동일 주문장 queue priority 보장
- 동일 수수료 tier 보장
- 정확히 동일한 liquidation/ADL 시점 보장
- 기존 legacy copy runner 데이터베이스 자동 마이그레이션
```

Portfolio Margin을 근사 계산으로 통과시키지 않는다.

---

# 5. 최대 5명 정책

코드 상수:

```javascript
MAX_TRACKED_WHALES = 5
```

정책:

```text
PAPER: 1~5명 허용
LIVE TESTNET: 1~5명 허용
LIVE MAINNET: 1~5명 허용하되 실제 운영 설정은 5명
```

현재 `runtime.mjs`의 다음 제한은 수정한다.

```text
Live runtime requires exactly five pairs
```

다음으로 변경한다.

```text
Live runtime accepts 1-5 pairs
socket budget = pair count × 2
socket budget <= 10
```

이유:

```text
1명 testnet → 5명 testnet → 1명 소액 mainnet → 5명 mainnet
```

단계 검증이 가능해야 한다.

운영용 config에는 5명을 넣되 테스트넷 검증을 위해 코드가 정확히 5명만 강제해서는 안 된다.

---

# 6. 계좌 분리 구조

운영 구조:

```text
Master account
│
├─ Target Subaccount 1 ↔ Source Whale 1
├─ Target Subaccount 2 ↔ Source Whale 2
├─ Target Subaccount 3 ↔ Source Whale 3
├─ Target Subaccount 4 ↔ Source Whale 4
└─ Target Subaccount 5 ↔ Source Whale 5
```

필수 불변조건:

```text
sourceAddress는 모두 고유
targetAddress는 모두 고유
sourceAddress와 targetAddress가 같으면 거부
한 target을 둘 이상의 pair가 공유하면 거부
LIVE에서 targetAddress 누락 시 거부
각 target은 해당 전략만 사용하는 전용 subaccount여야 함
```

같은 target 안에서 해당 고래의 Cross 포지션끼리는 담보를 공유한다.

다른 target subaccount 사이에서는:

```text
담보
포지션
손익
청산 위험
미체결 주문
```

이 섞이지 않아야 한다.

---

# 7. 포지션 복제 규칙

## 7.1 공통 스케일

Source의 해당 margin pool equity:

\[
E_s
\]

Target의 같은 margin pool equity:

\[
E_t
\]

Source 종목 signed notional:

\[
N_s
\]

Target 목표 signed notional:

\[
N_t=N_s\times\frac{E_t}{E_s}
\]

Target 목표 수량:

\[
Q_t=\frac{N_t}{P_{\text{current}}}
\]

롱은 양수, 숏은 음수다.

## 7.2 레버리지 이중 적용 금지

잘못된 계산:

```text
target notional = source notional/equity × target equity
target order = target notional × source leverage
```

레버리지를 다시 곱하지 않는다.

올바른 의미:

```text
target notional
→ 경제적 노출 크기

source leverage setting
→ 해당 target notional을 어떤 margin 설정으로 유지할지
```

## 7.3 Cross

Cross의 목표:

```text
- 동일 margin pool
- 동일 방향
- 동일 notional/equity 비율
- 동일 leverage.type = cross
- 동일 leverage.value
- source의 모든 Cross 포지션 구성
```

Cross는 종목별 독립 증거금 복제가 아니다.

```text
Source Cross portfolio 전체
→ 한 개의 전용 target subaccount 안에 축소 복제
```

## 7.4 Isolated

추가로 다음 비율을 맞춘다.

\[
R_m=\frac{M_s}{|N_s|}
\]

Source isolated margin:

\[
M_s
\]

Target isolated margin:

\[
M_t=|N_t|\times R_m
\]

필수:

```text
- leverage.type = isolated
- leverage.value 동일
- notional/equity 동일
- marginUsed/notional 동일
```

Source에 `marginUsed`가 없거나 유효하지 않으면 해당 포지션을 추정 통과시키지 않는다.

```text
ISOLATED_MARGIN_DATA_UNAVAILABLE
```

로 pair를 fail-closed한다.

---

# 8. 시작 시 포지션 동기화

정책명:

```text
SYNC_CURRENT_STATE_AT_MARK
```

시작 절차:

```text
1. source account mode 조회
2. target account mode 조회
3. mode 일치 확인
4. source와 target의 all-DEX state 조회
5. source current open orders 조회
6. target current open orders 조회
7. source positions의 margin-pool별 목표 계산
8. target leverage 및 mode 설정
9. 현재 L2에서 protected IOC로 포지션 동기화
10. isolated margin 보정
11. target 실제 snapshot 재조회
12. source open orders shadow 설치
13. bootstrap 중 버퍼링된 source 이벤트 순서대로 적용
14. full reconciliation
15. follower 성과 기준점을 이 시점에서 0으로 저장
```

금지:

```text
source entryPx를 follower 진입가로 사용
source의 이미 발생한 unrealized PnL을 follower PnL로 기록
```

Follower의 실제 진입가는 target의 실제 체결가다.

---

# 9. 주문 Shadow 규칙

## 9.1 복제 대상

```text
- GTC
- IOC
- ALO
- trigger/stop
- TP/SL
- reduceOnly
- BUY/SELL
- limit price
- trigger price
- TIF
- order type
- source leverage setting
- source remaining quantity
```

## 9.2 수량 스케일

\[
Q^{order}_t
=
Q^{remaining}_s\times\frac{E_t}{E_s}
\]

`reduceOnly=true`이면 target 현재 포지션 크기 이하로 cap한다.

## 9.3 주문 lifecycle

```text
Source CREATE
→ Target CREATE

Source MODIFY
→ Target MODIFY

Source CANCEL
→ Target CANCEL

Source PARTIAL FILL
→ Target remaining quantity MODIFY
→ 즉시 position catch-up

Source FULL FILL
→ Target remaining order CANCEL
→ 즉시 position catch-up
```

## 9.4 ALO

Follower ALO가 이미 crossing 상태여서 거절되면:

```text
ALO를 GTC나 market으로 임의 변환하지 않음
shadow order 설치 실패 상태 기록
source fill 발생 시 position catch-up
```

## 9.5 최소 주문수량

축소된 target 주문이 거래소 size precision 또는 최소 notional 아래라면:

```text
주문 전송 안 함
현재 desired position은 유지
tracking debt로 누적
향후 차이가 threshold를 넘으면 IOC 또는 order update
```

`SCALED_TO_ZERO`는 전략 포기 상태가 아니라 현재 주문 단위 미달 상태다.

---

# 10. Client Order ID 수정

현재 `domain.mjs`의 human-readable ID 형태:

```text
fmv2-xxxxxxxx-...
```

는 Hyperliquid `Cloid` 규격에 바로 사용할 수 없다.

단일 canonical 규칙으로 변경한다.

```text
targetCloid =
"0x" + SHA256(pairId + "|" + sourceOrderId)[0:32 hex chars]
```

요구사항:

```text
- 총 128-bit lowercase hex
- 정확히 /^0x[a-f0-9]{32}$/
- 동일 pair/source order에서 항상 동일
- 다른 pair에서는 충돌하지 않음
- create/modify/cancel/restart recovery에서 동일 값 사용
```

사람이 읽는 audit ID가 필요하면 별도 필드로 둔다.

```text
auditOrderId
targetCloid
```

절대 같은 필드로 혼용하지 않는다.

테스트:

```text
valid Hyperliquid cloid
deterministic
pair isolation
source order collision resistance
restart consistency
```

---

# 11. Fill 즉시 추격

고정 debounce를 사용하지 않는다.

Source fill 수신 즉시:

```text
1. fill.startPosition + signed fill size로 source after-position 계산
2. source local snapshot 즉시 갱신
3. source order remaining 갱신
4. 해당 target shadow order remainder를 먼저 축소/취소
5. 최신 target actual position 확인
6. target desired position 계산
7. 차이를 protected IOC로 즉시 제출
```

핵심:

```text
fill 하나마다 desired state는 즉시 갱신
이미 주문 실행 중이면 오래된 작업을 큐에 적층하지 않음
현재 실행이 끝나는 즉시 최신 desired와 다시 비교
```

현재 `FaithfulPairActor`의 `dirtyCoins` latest-state 구조를 유지한다.

## 11.1 부분체결 예시

```text
Source order: 100
Source fill: 50
Source remainder: 50

Scaled target original: 10
Target already filled: 2
```

새 상태:

```text
현재 target desired position: 5
미래에 남길 shadow remainder: 5
현재 target position: 2
즉시 catch-up: 3
```

순서:

```text
target shadow 8 remainder → 5로 modify
그 후 actual position 확인
차이 3을 IOC
```

## 11.2 완전체결

```text
source remainder = 0
```

이면:

```text
target shadow remainder cancel
actual vs desired 계산
차이만 IOC
```

## 11.3 검증 타이머

```text
0ms:
  첫 즉시 catch-up

250ms:
  최신 actual/desired residual 재검증
  필요 시 재보정

1,000ms:
  최종 residual 재검증
  허용치 초과 시 pair kill switch
```

1초 후 처음 주문하면 안 된다.

---

# 12. Hot path 지연 최적화

현재 `runtime.mjs`는 source order update마다 `activeAssetData` REST 조회를 수행할 수 있다. 이것은 주문 shadow 지연을 크게 늘릴 수 있다.

개선:

```text
- source leverage cache: sourceAddress + coin
- source snapshot의 position leverage를 우선 사용
- bootstrap 시 open-order coin leverage를 병렬 prefetch
- leverage가 cache에 있으면 order event를 REST 대기 없이 처리
- cache miss인 coin만 비동기 조회 후 해당 coin queue 재개
- 다른 pair/coin은 차단하지 않음
```

Hot path에서 금지:

```text
- 매 fill마다 clearinghouseState REST 재조회
- 매 order update마다 orderStatus REST 조회
- 1초 fixed wait 후 첫 catch-up
```

사용:

```text
- source WebSocket state
- target WebSocket state
- local order map
- local leverage cache
- target WebSocket signed post
```

REST는 다음에 사용한다.

```text
bootstrap
reconnect
post timeout
state mismatch
manual reconciliation
cache miss
```

---

# 13. 모든 DEX의 주문 조회

현재 단일:

```json
{"type":"frontendOpenOrders","user":"..."}
```

호출이 HIP-3 DEX 주문 전체를 보장한다고 가정하지 않는다.

Codex가 공식 응답을 확인한 뒤 다음 중 하나를 구현한다.

```text
A. 단일 요청이 all-DEX를 실제로 반환함을 fixture/testnet으로 증명
```

또는:

```text
B. perpDexs 및 allDexsClearinghouseState에서 관련 DEX 목록 수집
   DEX별 frontendOpenOrders 조회
   address + dex + oid로 dedup
```

요구사항:

```text
main perp open order
HIP-3 open order
trigger order
reduce-only order
```

가 bootstrap에서 빠지지 않아야 한다.

---

# 14. Reconnect와 프로세스 재시작

## 14.1 현재 메모리만으로 부족한 상태

현재 runtime의 다음 값은 메모리에만 있다.

```text
sourceLastFillTime
targetLastFillTime
seenFillIds
source-target order mapping
bootstrap 상태
```

프로세스 종료 후 복구할 수 있게 저장해야 한다.

## 14.2 저장 필드

pair별 checkpoint:

```json
{
  "pairId": "whale-1",
  "sourceAddress": "0x...",
  "targetAddress": "0x...",
  "lastSourceFillTime": 0,
  "lastTargetFillTime": 0,
  "recentSourceFillIds": [],
  "recentTargetFillIds": [],
  "sourceOrderToTargetCloid": {},
  "accountMode": "STANDARD",
  "lastSourceSnapshotAt": 0,
  "lastTargetSnapshotAt": 0,
  "killSwitch": false,
  "sessionId": "..."
}
```

민감정보 저장 금지:

```text
private key
signature
control token
full environment
```

## 14.3 시작 복구

```text
1. checkpoint 로드
2. target current orders/state 조회
3. source current orders/state 조회
4. lastFillTime - overlap 1~5초부터 raw fills backfill
5. stable fill identity dedup
6. open-order mapping 복원
7. target actual state를 authoritative로 채택
8. current source state로 desired 재계산
9. full reconciliation
```

## 14.4 누락 감지

다음이면 fail-closed:

```text
fill backfill pagination 불완전
cursor stall
10,000-history coverage 제한 도달
source/target account mode 변경
target subaccount 미확인 포지션 발견
target에 소유권을 알 수 없는 open order 발견
```

상태:

```text
PAIR_RECOVERY_BLOCKED
```

수동 확인 전 신규 주문을 보내지 않는다.

## 14.5 fill ID 보존

현재처럼 100,000개가 되면 전체 `Set.clear()`하지 않는다.

다음 중 하나:

```text
bounded LRU
timestamp-based eviction
persistent ring buffer
```

로 변경한다.

---

# 15. 설정 로더

`config.mjs`를 authoritative loader로 만든다.

## 15.1 입력

```text
FMV2_CONFIG
FMV2_CONTROL_TOKEN
FMV2_MASTER_ACCOUNT_ADDRESS
FMV2_AGENT_PRIVATE_KEY_1..5
FMV2_PYTHON
FMV2_BRIDGE_PATH
FMV2_ACTION_EXPIRES_AFTER_MS
FMV2_TESTNET
FMV2_PRODUCTION_CONFIRMED
```

민감정보는 JSON config에 넣지 않는다.

## 15.2 JSON config

```json
{
  "mode": "PAPER",
  "testnet": true,
  "pairs": [
    {
      "pairId": "whale-1",
      "sourceAddress": "0x...",
      "targetAddress": "0x...",
      "capitalUsd": 100
    }
  ],
  "actorConfig": {
    "immediateResidualNotionalUsd": 10,
    "targetPositionToleranceBps": 5,
    "verificationDelayMs": 250,
    "terminalVerificationDelayMs": 1000,
    "maxCatchUpSlippageBps": 50,
    "killOnTerminalResidual": true
  }
}
```

## 15.3 검증

- [ ] mode는 `PAPER` 또는 `LIVE`
- [ ] pair 수 1~5
- [ ] source unique
- [ ] target unique
- [ ] LIVE에서는 target 필수
- [ ] capitalUsd > 0
- [ ] port 유효
- [ ] control token 최소 16자
- [ ] slippage 범위 유효
- [ ] verification delay 양수
- [ ] mainnet 이중 확인
- [ ] LIVE pair별 API key 존재
- [ ] secret이 config 파일에 있으면 경고 또는 거부
- [ ] 경로는 config 파일 위치 또는 service root를 기준으로 명확히 resolve

---

# 16. `index.mjs`

역할:

```text
- config load
- audit store initialize
- PAPER/LIVE system construct
- control server start
- signal handler
- snapshot timer
- arm/start/stop/kill lifecycle
- uncaught exception fail-safe
```

## 16.1 초기 상태

```text
PAPER:
  autoStart는 config로 허용

LIVE:
  절대 autoStart 금지
  항상 STOPPED_UNARMED
```

## 16.2 종료

```text
SIGINT/SIGTERM
→ 신규 action 차단
→ target shadow order 취소
→ checkpoint/snapshot flush
→ sockets close
→ signer bridge close
```

포지션 자동 청산은 기본값이 아니다.

---

# 17. Control server

엔드포인트:

```text
GET  /health
GET  /status

POST /arm
POST /start
POST /stop
POST /kill
POST /reconcile
```

## 17.1 인증

```text
/health
→ 인증 없이 {ok:true}만 반환

그 외
→ x-fmv2-control-token
→ timingSafeEqual
```

## 17.2 `/arm`

LIVE에서만 사용.

body:

```json
{
  "confirmation": "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS"
}
```

TTL:

```text
60 seconds
```

`/start` 성공 후 arm 즉시 소모.

## 17.3 `/stop`

기본:

```text
- 신규 주문 중단
- shadow order 취소
- 현재 포지션 유지
- 상태 저장
```

## 17.4 `/kill`

기본:

```text
- 신규 주문 차단
- 모든 FMV2 shadow order 취소
- current positions 유지
- killSwitch 기록
```

자동 flatten은 별도 명시 옵션 없이는 실행하지 않는다.

## 17.5 `/reconcile`

현재 source/target state를 다시 읽고 full reconciliation한다.

LIVE에서는 armed 상태 또는 별도의 안전 확인을 요구한다.

---

# 18. Python signer bridge

필수 파일:

```text
hyperliquid_pair_bridge.py
```

의존성:

```text
hyperliquid-python-sdk==0.24.0
```

## 18.1 통신

stdin:

```json
{"id":1,"operation":"preflight","payload":{}}
```

stdout:

```json
{"id":1,"ok":true,"result":{}}
```

오류:

```json
{"id":1,"ok":false,"error":"..."}
```

stdout에는 JSON reply만 출력한다.

진단 로그는 stderr로 보낸다.

## 18.2 환경변수

pair별 child process:

```text
FMV2_AGENT_PRIVATE_KEY
FMV2_MASTER_ACCOUNT_ADDRESS
FMV2_TARGET_ACCOUNT_ADDRESS
FMV2_TESTNET
FMV2_ACTION_EXPIRES_AFTER_MS
```

## 18.3 필수 operation

```text
preflight
signSetLeverage
signAdjustIsolatedMargin
signUpsertOrder
signCancelOrder
signProtectedIoc
```

## 18.4 반환 계약

서명 operation:

```json
{
  "signedPayload": {
    "action": {},
    "nonce": 0,
    "signature": {},
    "vaultAddress": "0x...",
    "expiresAfter": 0
  }
}
```

Node의 target `UserSocket.postAction()`이 이를 그대로 WebSocket `post`로 보낸다.

## 18.5 서명 원칙

공식 SDK의 다음 로직을 사용한다.

```text
name_to_asset
order_request_to_order_wire
order_wires_to_order_action
sign_l1_action
get_timestamp_ms
Cloid
```

SDK 내부 포맷을 임의로 재구성하지 않는다.

## 18.6 `preflight`

검증:

```text
- API wallet 형식
- master 주소
- target 주소
- target이 master 또는 master의 전용 subaccount인지
- SDK version
- target account state
- target open orders
- target equity > 0
- target account mode
```

target에 기존 포지션이나 주문이 있을 때 정책:

```text
exclusiveTargetAccount=true
→ 모든 기존 target 주문 정리 가능
→ 기존 포지션이 있으면 기본 거부

adoptExistingTargetState=true
→ 명시적으로만 허용
```

기본은 신규·전용 subaccount다.

## 18.7 `signSetLeverage`

action:

```text
updateLeverage
asset
isCross
leverage
```

## 18.8 `signAdjustIsolatedMargin`

공식 SDK 0.24.0의 `update_isolated_margin` wire schema를 그대로 따른다.

중요:

```text
marginDeltaUsd의 양수/음수 의미를 추측하지 말 것
testnet에서 add/remove 각각 검증할 것
isolated-only asset의 margin removal 제한 처리
```

## 18.9 `signUpsertOrder`

신규:

```text
order action
canonical cloid
```

수정:

```text
batchModify
기존 target exchange OID 우선
없으면 canonical cloid 기반 복구
```

지원:

```text
GTC / IOC / ALO
trigger market / trigger limit
TP / SL
reduceOnly
```

## 18.10 `signCancelOrder`

우선순위:

```text
exchange OID 있음
→ cancel by OID

없음
→ cancelByCloid
```

## 18.11 `signProtectedIoc`

```text
side = sign(deltaSize)
size = abs(deltaSize)
limit price = mark ± maxSlippageBps
TIF = IOC
reduceOnly = actor 전달값
```

source leverage를 수량에 다시 곱하지 않는다.

## 18.12 보안

- [ ] private key stdout 금지
- [ ] private key stderr 금지
- [ ] signed payload audit 저장 금지
- [ ] full environment dump 금지
- [ ] exception에 secret 포함 금지
- [ ] `.env` gitignore
- [ ] mainnet confirmation 없으면 sign operation 거부

---

# 19. LIVE runtime

## 19.1 연결 수

pair당:

```text
source user socket 1
target user socket 1
```

5 pair:

```text
10 user sockets
```

signed action은 target socket의 기존 `post`를 사용한다.

추가 action socket을 만들지 않는다.

## 19.2 subscriptions

Source:

```text
allDexsClearinghouseState
userFills aggregateByTime=false
orderUpdates
```

Target:

```text
allDexsClearinghouseState
userFills aggregateByTime=false
orderUpdates
```

필요 시 funding 및 non-funding delta는 별도 예산을 고려한다.

## 19.3 bootstrap buffer

source/target state와 open orders가 모두 준비되기 전 이벤트는:

```text
monotonic event sequence
```

로 버퍼링한다.

bootstrap 완료 후 wire order대로 적용한다.

## 19.4 target authoritative

다음 우선순위를 사용한다.

```text
target WebSocket state
> target fill result
> local optimistic state
```

target snapshot이 들어오면 local optimistic state를 교정한다.

---

# 20. PAPER runtime

PAPER는 LIVE와 동일한 actor를 사용한다.

## 20.1 필수 현실성

- [ ] 초기 포지션은 현재 L2에서 체결
- [ ] source entry price 소급 금지
- [ ] L2 depth walking
- [ ] partial fill
- [ ] slippage cap
- [ ] maker/taker fee
- [ ] ALO would-cross reject
- [ ] resting queue-ahead
- [ ] public trades로 resting fill
- [ ] funding 반영
- [ ] minimum size / notional
- [ ] Cross/isolated leverage 상태
- [ ] isolated margin
- [ ] pair별 독립 equity
- [ ] realized/unrealized PnL
- [ ] fees/funding 별도 집계

## 20.2 추가해야 할 위험 모델

현재 paper venue를 검토하여 다음이 없다면 추가한다.

```text
- initial margin sufficiency
- pool별 available collateral
- isolated margin insufficiency
- negative equity 감지
- approximate maintenance margin
- liquidation event 또는 최소한 LIQUIDATION_RISK_BLOCKED 상태
```

정확한 거래소 청산 모델을 구현하지 못하면:

```text
simulationModelVersion
liquidationModel = APPROXIMATE | NOT_IMPLEMENTED
```

를 상태와 README에 명시한다.

“실전과 동일한 청산”이라고 주장하면 안 된다.

---

# 21. 자금 및 입출금 정책

기본:

```text
각 target subaccount의 자본은 고정
source 입출금은 target 자금이체로 복제하지 않음
source equity 변화에 따라 target exposure ratio를 재조정
```

예:

```text
source 입금
→ source position/equity 비율 감소
→ target position 축소

source 출금
→ source position/equity 비율 증가
→ target position 확대
```

위험:

source가 큰 출금을 하여 leverage가 급상승하면 target도 급상승한다.

따라서 status에 다음을 표시한다.

```text
sourceGrossExposure
targetGrossExposure
sourceEquityChange
rebalanceCause
```

임의 leverage cap은 Faithful 모드에 넣지 않는다. 별도 deployable mode를 만들 경우 분리된 config와 결과로 운영한다.

---

# 22. Audit 및 observability

## 22.1 저장

```text
events.jsonl
latest-state.json
recovery-checkpoint.json
```

atomic write.

## 22.2 이벤트 필드

```json
{
  "sessionId": "...",
  "pairId": "whale-1",
  "sourceAddress": "0x...",
  "targetAddress": "0x...",
  "type": "SOURCE_FILL",
  "coin": "BTC",
  "sourceEventTime": 0,
  "receivedAt": 0,
  "actionSentAt": 0,
  "actionCommittedAt": 0,
  "latencyMs": 0,
  "detail": {}
}
```

## 22.3 필수 metrics

pair별:

```text
source_fill_count
source_order_update_count
shadow_create_count
shadow_modify_count
shadow_cancel_count
immediate_catchup_count
catchup_fill_rate
catchup_slippage_bps
position_tracking_error_bps
250ms_residual_bps
1000ms_residual_bps
terminal_residual_count
reconnect_count
backfilled_fill_count
order_shadow_latency_ms
source_fill_to_action_send_ms
action_send_to_commit_ms
source_fill_to_target_fill_ms
fees
funding
realized_pnl
unrealized_pnl
```

p50/p95/p99를 계산 가능하게 raw timestamps를 보존한다.

## 22.4 상태

```text
STOPPED
STARTING
BOOTSTRAPPING
RUNNING
DEGRADED
PAIR_RECOVERY_BLOCKED
KILLED
STOPPING
```

---

# 23. 기존 코드에서 반드시 감사할 항목

- [ ] `createLiveMirrorSystem`의 exactly-five 제한 제거
- [ ] `HyperliquidMirrorRuntime`의 exactly-five 제한 제거
- [ ] socket count가 `2 * pairs.length`
- [ ] human ID를 Cloid로 쓰지 않음
- [ ] source order leverage REST hot-path cache
- [ ] all-DEX open-order coverage
- [ ] Unified default fail-closed
- [ ] Portfolio Margin fail-closed
- [ ] isolated `marginUsed` 누락 fail-closed
- [ ] source fill 후 target order cancellation이 catch-up보다 먼저 완료
- [ ] target fill이 들어오면 latest desired 재검증
- [ ] target snapshot이 optimistic state 교정
- [ ] reduce-only overshoot 방지
- [ ] reverse position delta 처리
- [ ] source flat이면 target flat으로 catch-up
- [ ] minimum-size tracking debt
- [ ] 250ms timer가 자신을 무한 재예약하지 않음
- [ ] 1,000ms residual 후 pair kill
- [ ] one pair failure가 나머지 pair를 불필요하게 중지하지 않음
- [ ] global kill은 명시적으로만
- [ ] stop 시 open shadow order cleanup
- [ ] restart 후 target orders ownership 복구
- [ ] unknown target order/position 감지
- [ ] private key log 없음

---

# 24. 테스트 요구사항

## 24.1 Domain

- [ ] 5명 허용
- [ ] 6명 거부
- [ ] duplicate source 거부
- [ ] duplicate target 거부
- [ ] Cross signed notional/equity scaling
- [ ] Short scaling
- [ ] source leverage를 notional에 이중 적용하지 않음
- [ ] Isolated margin ratio scaling
- [ ] missing isolated margin 거부
- [ ] margin pool missing 거부
- [ ] HIP-3 coin normalization
- [ ] canonical Cloid 규격
- [ ] reduce-only quantity cap
- [ ] residual threshold accumulation

## 24.2 Actor

- [ ] bootstrap current position at mark
- [ ] source open orders bootstrap
- [ ] CREATE
- [ ] MODIFY
- [ ] CANCEL
- [ ] source partial fill
- [ ] source full fill
- [ ] source market fill
- [ ] target partial fill
- [ ] target overshoot
- [ ] reversal
- [ ] source flat
- [ ] multiple fills during in-flight catch-up
- [ ] latest state only
- [ ] order remainder 수정 후 IOC
- [ ] ALO rejection then fill catch-up
- [ ] isolated margin after position
- [ ] source equity change rebalance
- [ ] target equity change rebalance
- [ ] 250ms verification
- [ ] 1000ms terminal kill

## 24.3 Runtime

- [ ] 1~5 pair
- [ ] 2 sockets per pair
- [ ] bootstrap buffering
- [ ] source/target address attribution
- [ ] source fill dedup
- [ ] target fill dedup
- [ ] reconnect backfill
- [ ] reconnect open-order resync
- [ ] all-DEX open orders
- [ ] active leverage cache
- [ ] target `post` response correlation
- [ ] post timeout
- [ ] stale socket reconnect
- [ ] Portfolio Margin reject
- [ ] Unified opt-in

## 24.4 PAPER

- [ ] L2 book walk
- [ ] partial IOC
- [ ] slippage limit
- [ ] maker queue ahead
- [ ] ALO reject
- [ ] GTC resting fill
- [ ] fee accounting
- [ ] funding accounting
- [ ] realized PnL
- [ ] reversal entry price
- [ ] independent pair equity
- [ ] margin insufficiency
- [ ] liquidation risk reporting

## 24.5 LIVE contract

네트워크를 쓰지 않는 fake transport로:

- [ ] signer operation 이름
- [ ] signed payload schema
- [ ] updateLeverage schema
- [ ] isolated margin schema
- [ ] create order schema
- [ ] modify schema
- [ ] cancel by OID
- [ ] cancel by Cloid
- [ ] protected IOC
- [ ] target subaccount/vault address
- [ ] expiresAfter
- [ ] five distinct API wallets
- [ ] no secret in logs
- [ ] arm required
- [ ] arm TTL
- [ ] mainnet confirmation

## 24.6 Restart

- [ ] audit flush
- [ ] checkpoint write
- [ ] checkpoint load
- [ ] source fill backfill overlap dedup
- [ ] target fill backfill overlap dedup
- [ ] source-target order map restore
- [ ] unknown target order blocks
- [ ] unknown target position blocks
- [ ] interrupted action timeout reconciliation

---

# 25. 실행 명령

완료 후 다음이 모두 동작해야 한다.

```bash
cd dashboard/services/faithful-mirror-v2

python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

npm test
npm run check
```

PAPER:

```bash
set FMV2_CONFIG=config/five-whale-paper.json
set FMV2_CONTROL_TOKEN=replace-with-long-random-token
npm start
```

LIVE testnet은 자동 시작 금지:

```bash
set FMV2_CONFIG=config/five-whale-live-testnet.json
set FMV2_CONTROL_TOKEN=replace-with-long-random-token
set FMV2_TESTNET=true
set FMV2_MASTER_ACCOUNT_ADDRESS=0x...
set FMV2_AGENT_PRIVATE_KEY_1=0x...
npm start
```

그 후:

```bash
curl http://127.0.0.1:8790/health
curl -H "x-fmv2-control-token: TOKEN" http://127.0.0.1:8790/status

curl -X POST ^
  -H "content-type: application/json" ^
  -H "x-fmv2-control-token: TOKEN" ^
  -d "{\"confirmation\":\"I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS\"}" ^
  http://127.0.0.1:8790/arm

curl -X POST ^
  -H "x-fmv2-control-token: TOKEN" ^
  http://127.0.0.1:8790/start
```

실제 endpoint body는 README와 일치시킨다.

---

# 26. Clean-clone 검증

작업 디렉터리의 untracked 파일에 의존하지 않는지 확인한다.

```bash
git status --short
git push -u origin feature/five-whale-faithful-mirror-v2-integrated

cd ..
git clone <repo-url> fmv2-clean
cd fmv2-clean
git checkout feature/five-whale-faithful-mirror-v2-integrated

cd dashboard/services/faithful-mirror-v2
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

npm test
npm run check
```

추가:

```bash
cd ../../
npm test
```

전체 dashboard 테스트가 너무 무겁더라도 PR 전에는 한 번 실행한다.

---

# 27. Testnet 검증 단계

Codex 작업에서 실제 funded 주문을 임의로 보내지 않는다.

사용자가 credential과 funded target을 제공한 뒤 별도 수행한다.

## 단계 A — 1 pair PAPER

```text
24시간 이상
현재 포지션 sync
open order shadow
fill catch-up
reconnect
funding
```

확인:

```text
tracking error
shadow latency
catch-up rate
slippage
fees
```

## 단계 B — 1 pair LIVE testnet

매우 작은 testnet 자금.

필수 시나리오:

```text
GTC create/modify/cancel
ALO
IOC
partial fill
reduce-only
position reversal
cross leverage change
isolated position
isolated margin add/remove
socket reconnect
process restart
```

## 단계 C — 5 pair LIVE testnet

확인:

```text
10 user sockets
5 signer processes 또는 독립 signer contexts
nonce 충돌 없음
rate limit 안정
한 pair 장애 격리
```

## 단계 D — 1 pair 소액 mainnet

수동 승인 후만.

## 단계 E — 5 pair mainnet

다음 조건을 모두 만족한 뒤:

```text
- testnet 5 pair 안정
- terminal residual 0 또는 설명 가능
- reconnect recovery 성공
- mainnet risk review
- target subaccounts 전용 확인
- 사용자의 명시 승인
```

---

# 28. 성능 목표

보장값이 아니라 측정 목표다.

로컬 처리:

```text
source WS receive → desired state update:
p50 < 2ms
p95 < 10ms
```

action 송신:

```text
source fill receive → target post send:
p50 < 10ms
p95 < 50ms
```

실제 committed response는 외부 네트워크·거래소 지연을 포함하므로 측정만 한다.

필수 보고:

```text
p50
p95
p99
maximum
sample count
server location
testnet/mainnet
```

지연 목표를 맞추기 위해 정확성 검증을 제거하지 않는다.

---

# 29. README에 반드시 포함할 내용

```text
- 시스템 목적
- 5 source ↔ 5 target 구조
- PAPER와 LIVE 차이
- Cross/isolated 복제식
- 시작 시 current mark sync
- 모든 open order shadow
- fill-triggered reconciliation
- supported account modes
- unsupported Portfolio Margin
- config 설명
- environment 설명
- PAPER 실행
- LIVE testnet 실행
- arm/start/stop/kill
- 데이터 파일 위치
- recovery 절차
- 보안 주의
- mainnet 경고
- known limitations
```

“정확히 동일한 거래”라고 표현하지 않는다.

권장 표현:

```text
Faithful state mirror
```

---

# 30. GitHub 작업 완료 절차

1. 통합 브랜치 push
2. Draft PR 생성
3. PR base:

```text
feature/verified-perp-twr-pipeline
```

4. PR title:

```text
Integrate five-whale Faithful Mirror V2 paper and live service
```

5. PR 본문에 포함:

```text
- 현재 브랜치 혼선 정리
- 누락 파일 추가
- PAPER/LIVE 구조
- 5명 제한
- 테스트 결과
- clean-clone 결과
- 실제 network 주문 미실행
- 남은 testnet 검증
```

main merge는 사용자가 검토한 뒤 한다.

---

# 31. 완료 판정 체크리스트

## 원격 구조

- [ ] 통합 브랜치가 기준 브랜치보다 ahead
- [ ] `index.mjs` 존재
- [ ] `config.mjs` 존재
- [ ] `control-server.mjs` 존재
- [ ] `hyperliquid_pair_bridge.py` 존재
- [ ] `README.md` 존재
- [ ] package scripts가 실제 파일만 참조
- [ ] legacy runner 무변경 또는 필요한 최소 독립 변경
- [ ] PR 생성

## 기능

- [ ] 1~5 pair
- [ ] 5명 초과 거부
- [ ] distinct target
- [ ] current mark position sync
- [ ] Cross copy
- [ ] Isolated copy
- [ ] leverage copy
- [ ] isolated margin copy
- [ ] existing open orders copy
- [ ] create/modify/cancel
- [ ] immediate fill chase
- [ ] latest-state actor
- [ ] 250ms verification
- [ ] 1000ms terminal check
- [ ] reconnect backfill
- [ ] restart recovery
- [ ] PAPER fees/funding/slippage
- [ ] LIVE arm gate
- [ ] mainnet confirmation
- [ ] kill switch

## 검증

- [ ] `npm test`
- [ ] `npm run check`
- [ ] Python compile
- [ ] root dashboard tests
- [ ] clean clone
- [ ] no private keys committed
- [ ] no `.env` committed
- [ ] no mainnet order sent
- [ ] no unsupported mode silently accepted

---

# 32. Codex 최종 보고 형식

작업 완료 후 아래 형식으로 답한다.

```markdown
## 작업 브랜치
- branch:
- base:
- head commit:

## 기존 원격 문제
- missing files:
- divergent branches:
- package mismatch:

## 구현 요약
- config/entrypoint:
- control server:
- PAPER:
- LIVE:
- signer bridge:
- persistence/recovery:

## Cross 복제
- formula:
- margin pool handling:

## Isolated 복제
- formula:
- margin adjustment:

## 주문 미러링
- create:
- modify:
- cancel:
- trigger/reduce-only:
- canonical cloid:

## Fill 즉시 보정
- hot path:
- 250ms:
- 1000ms:
- latest-state handling:

## 테스트
- service tests:
- Python tests:
- dashboard tests:
- clean-clone:

## GitHub
- pushed:
- PR:
- changed files:

## 실제 주문 여부
- paper only:
- testnet orders:
- mainnet orders:

## 남은 사항
- testnet verification:
- known limitations:
- security review:
```

---

# 33. Codex가 작업 시작 직후 실행할 감사 명령

```bash
git fetch origin --prune

git branch -r | findstr faithful-mirror

git diff --stat \
  origin/feature/verified-perp-twr-pipeline..origin/feature/five-whale-faithful-mirror-v2-final

git diff --stat \
  origin/feature/verified-perp-twr-pipeline..origin/feature/five-whale-faithful-mirror-v2

git diff --stat \
  origin/feature/verified-perp-twr-pipeline..origin/feature/five-whale-faithful-mirror-v2-complete

git ls-tree -r --name-only \
  origin/feature/five-whale-faithful-mirror-v2-final \
  dashboard/services/faithful-mirror-v2

git show \
  origin/feature/five-whale-faithful-mirror-v2-final:dashboard/services/faithful-mirror-v2/package.json
```

다음을 직접 재확인한 후 코드를 수정한다.

```text
index.mjs 존재 여부
hyperliquid_pair_bridge.py 존재 여부
README.md 존재 여부
PR 존재 여부
```

---

# 34. 최종 원칙

1. 고래의 각 fill은 즉시 목표 상태 변경을 촉발한다.
2. 고래의 주문은 가능한 한 미리 동일 속성으로 shadow한다.
3. 주문 shadow와 fill catch-up을 동시에 사용한다.
4. 목표 포지션은 source notional/equity를 target equity에 적용한다.
5. source leverage는 증거금 설정으로 복제하며 수량에 다시 곱하지 않는다.
6. Cross는 포트폴리오 전체를 전용 target 안에 복제한다.
7. Isolated는 실제 marginUsed 비율까지 맞춘다.
8. 현재 포지션은 현재 시장가로 시작한다.
9. 고래별 target 계좌를 완전히 분리한다.
10. PAPER와 LIVE가 같은 actor를 사용한다.
11. 외부 지연 때문에 동일 체결을 보장한다고 주장하지 않는다.
12. 불완전 상태는 fail-closed한다.
13. mainnet은 자동 시작하지 않는다.
14. clean clone에서 재현되지 않으면 완료가 아니다.
15. GitHub에 실제 존재하지 않는 파일·PR·테스트 결과를 완료라고 보고하지 않는다.
