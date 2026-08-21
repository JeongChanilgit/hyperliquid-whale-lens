# Whale Lens

Hyperliquid 공개 지갑의 최근 30일 거래를 코인 차트에 재생하고, 최대 10개 지갑의 주문·레버리지를 Hyperliquid 모의 계정 또는 같은 거래소의 실전 대상 계정에 복제하는 개인용 대시보드입니다.

## 실행

Node.js 22.13 이상에서:

```bash
npm install
npm run dev
npm run build
npm run lint
```

## 내 PC에서 site + 24/7 runner 함께 실행 (Windows PowerShell)

한 명이 자신의 PC에서만 대시보드와 장기 runner를 실행할 때는 아래 명령을 사용합니다. 주소를 주지 않으면 runner의 `SEED_WALLETS` TOP 10 기본값을 사용합니다. 직접 지정하면 1~10개 주소로 바꿀 수 있습니다.

```powershell
npm run local:start
npm run local:start -- -FollowerCapitalUsd 1000
npm run local:start -- -WhaleAddress 0x1111111111111111111111111111111111111111 -FollowerCapitalUsd 100
npm run local:status
npm run local:stop
```

이 명령은 runner를 `127.0.0.1:8788`, site를 `localhost:3000`에만 바인딩하고, localhost 전용 control token을 사용자별 `%LOCALAPPDATA%\WhaleLens` 상태 파일에도 기록합니다. site는 `COPY_RUNNER_BASE_URL=http://127.0.0.1:8788`로 runner bridge를 사용합니다.

- 로컬 시작 스크립트는 `HYPERLIQUID_ENABLED=false`, `COPY_RUNNER_MODE=SIMULATION`을 **강제**하므로 실제 주문을 전송하지 않습니다.
- Windows 예약 작업 `WhaleLensCopyRunner`처럼 이미 `127.0.0.1:8788`에서 표준 local simulation runner가 건강하게 실행 중이면 이를 **adopt**하고 site만 시작합니다. adoption한 runner는 `local:stop`으로 종료되지 않습니다.
- 표준 로컬 모의투자 runner가 이미 실행 중이면 안전하게 연결해서 재사용합니다. 기본 사이트 포트 3000이 사용 중이면 3010까지 다음 빈 포트를 자동 선택하며, 실행 중인 data prefetch/copy-runner 작업은 경고로 표시됩니다.
- 중지 명령은 이 스크립트가 시작해 PID와 시작 시각을 기록한 프로세스 트리만 종료합니다. 로컬 스크립트 내부의 simulation-only bridge token은 실주문에 사용할 수 없고, 실제 secret은 저장소나 `.env.example`에 쓰지 않습니다.

## 동작 원칙

- 차트 캔들과 30일 지갑 데이터는 IndexedDB에 범위·주기별로 저장하며, 15분·1시간·4시간·1일 캔들 전환과 버튼/휠/핀치 확대·축소를 지원합니다. 명시적인 새로고침 때만 강제로 다시 받습니다.
- 각 고래는 독립 WebSocket으로 `orderUpdates`, `userFills`, `allDexsClearinghouseState`를 감시합니다. `orderUpdates`가 사용자 주소를 포함하지 않으므로 여러 고래의 주문을 한 연결에 섞지 않으며, 기본 퍼프와 HIP-3 DEX 계좌가치를 합쳐 잔고 비율을 계산합니다.
- 시작할 때 `frontendOpenOrders`로 기존 미체결 주문을 불러오고, 이후 지정가 등록·수정·부분체결·전체체결·취소·거절·트리거 상태를 SQLite에 보존합니다. 최초 `userFills` snapshot은 주문으로 실행하지 않습니다.
- 모의투자는 첫 번째 최신 계좌 상태에서 이미 열려 있던 고래 포지션도 현재 시장가를 기준으로 잔고 비례 동기화합니다. 시작 전 수익은 소급하지 않고, 이후 추가진입·부분청산·전량청산부터 모의 손익에 반영하며 동기화된 포지션은 SQLite에 보존합니다.
- 각 고래는 서로 자금과 손익을 공유하지 않는 독립 지갑으로 계산합니다. 주문 수량은 `고래 주문수량 × (해당 지갑 현재자산 ÷ 고래 현재자산)`이며 기본 초기금은 지갑당 $100입니다. 임의의 20x 상한은 적용하지 않고 공개 `activeAssetData`에서 읽은 고래의 cross/isolated 및 레버리지를 그대로 사용합니다.
- 분할 진입, 추가 진입, 부분 청산, 전량 청산, 반전은 매 체결마다 새 목표와 follower 포지션의 차이로 각각 계산합니다. 계좌가치가 없거나 60초 넘게 오래됐으면 고정 수량으로 되돌아가지 않고 해당 복사를 차단합니다.
- 분석 화면은 모든 진입·추가진입·부분청산·전량청산에 `롱` 또는 `숏` 방향을 붙이고, 반전 체결은 `롱 청산 → 숏 진입`처럼 한 줄에 함께 표시합니다.
- 모의 로그는 standalone runner의 SQLite에 보관되며 브라우저를 닫아도 runner가 켜져 있으면 WebSocket 감시가 계속됩니다.
- 실전 경로는 고래별 직렬 순서만 보존하고 서로 다른 고래의 처리는 병렬화합니다. 동일 지정가가 후순위로 남더라도 고래 주문 전량체결 후 1초까지 기다리며, 그때 추종 잔량이 남으면 먼저 취소한 후 부족분만 보호형 시장가 IOC로 보정합니다. 보정 수량·평균가·슬리피지·실제 대기시간은 감사 로그에 기록됩니다.
- API wallet private key는 브라우저 번들·로컬 저장소·API 요청 body에 들어가지 않습니다. WebSocket·공개 정보 조회·서명 HTTP 왕복이 있어 절대적인 0µs 지연은 보장할 수 없고, 내부 실행 지연은 소수점 밀리초 단위로 기록합니다.

## Hyperliquid 서버 환경

실전 탭은 private Sites 인증 사용자 또는 standalone bridge control token으로만 제어됩니다. 서버 런타임에 아래 값을 별도로 설정합니다.

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r services/copy-runner/requirements.txt
```

```text
COPY_RUNNER_MODE=HYPERLIQUID
HYPERLIQUID_ENABLED=true
HYPERLIQUID_TESTNET=true
HYPERLIQUID_AGENT_PRIVATE_KEY=0x...
HYPERLIQUID_MASTER_ACCOUNT_ADDRESS=0x...
HYPERLIQUID_TARGETS_JSON={"0xsource":{"accountAddress":"0xtarget","vaultAddress":"0xtarget"}}
HYPERLIQUID_CATCHUP_SLIPPAGE=0.05
```

각 source는 서로 다른 target 계정/서브계정에 정확히 하나씩 매핑되어야 합니다. 테스트넷이 기본이며 mainnet은 `HYPERLIQUID_TESTNET=false`와 `HYPERLIQUID_PRODUCTION_CONFIRMED=I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS`가 함께 있어야 합니다. 시작 시 공식 SDK 존재 여부·매핑 일치·각 대상 perp 잔고를 점검합니다. 주문 실패 또는 1초 보정 후 잔량이 남으면 kill switch를 켭니다.

24시간 수집기는 `npm run copy-runner`로 별도 장기 실행 프로세스에서 구동합니다. 기본 로컬 명령은 계속 모의투자 전용이며, 실전은 위 서버 환경을 별도로 지정한 전용 runner에서만 활성화됩니다.

## 운영 제약

서버리스 인스턴스 자체는 24시간 WebSocket 수집기로 쓰지 않습니다. 실제 상시 수집과 서명은 로컬 standalone runner가 담당합니다. 실전 전에는 테스트넷에서 10개 대상 계정의 자금·API wallet 권한·주문 정밀도·1초 보정 로그를 검증해야 합니다.
