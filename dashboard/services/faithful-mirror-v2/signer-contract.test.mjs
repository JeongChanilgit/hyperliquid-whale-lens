import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HyperliquidLiveExecutionPort } from "./live-port.mjs";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const canonicalCloid = "0x11111111111111111111111111111111";
const privateKey = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

class FakeSigner {
  constructor() { this.calls = []; }
  async request(operation, payload = {}) {
    this.calls.push({ operation, payload });
    if (operation === "preflight") return { ok: true, openOrders: [] };
    return { signedPayload: { action: { type: operation }, nonce: this.calls.length, signature: { r: "0x1", s: "0x2", v: 27 }, vaultAddress: target, expiresAfter: 999 } };
  }
  close() {}
}

class FakeTransport {
  constructor() { this.posts = []; }
  async postAction(payload) {
    this.posts.push(payload);
    const status = payload.action.type === "signUpsertOrder"
      ? [{ resting: { oid: 7 } }]
      : payload.action.type === "signProtectedIoc"
        ? [{ filled: { oid: 8, totalSz: "0.1", avgPx: "100" } }]
        : [];
    return { type: "action", payload: { status: "ok", response: { data: { statuses: status } } } };
  }
}

const runFakePythonHarness = (script) => {
  const bridgePath = fileURLToPath(new URL("./hyperliquid_pair_bridge.py", import.meta.url));
  const child = spawnSync(process.env.PYTHON ?? "python", ["-c", script, bridgePath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
};

test("LIVE port contract uses fake signer and transport only, preserves operation names, and never logs a secret", async () => {
  const bridge = new FakeSigner();
  const transport = new FakeTransport();
  const logs = [];
  const port = new HyperliquidLiveExecutionPort({ pairId: "p1", sourceAddress: source, targetAddress: target, bridge, log: (event) => logs.push(event) });
  port.attachActionTransport(transport);
  await port.registerPair({ targetSnapshot: { positions: [{ coin: "BTC", signedSize: 1 }] } });
  await port.setLeverage({ coin: "BTC", leverage: { type: "isolated", value: 5 } });
  await port.adjustIsolatedMargin({ coin: "BTC", marginDeltaUsd: 10, targetMarginUsd: 20 });
  await port.upsertOrder({ sourceOrderId: "source-1", targetOrderId: canonicalCloid, order: { coin: "BTC", side: "BUY", quantity: 0.1, price: 100, tif: "GTC", reduceOnly: false } });
  await port.cancelOrder({ targetOrderId: canonicalCloid });
  await port.protectedIoc({ coin: "BTC", deltaSize: 0.1, markPriceUsd: 100, maxSlippageBps: 50, desiredSignedSize: 1.1, actualSignedSize: 1, reduceOnly: false, leverage: { type: "isolated", value: 5 } });
  assert.deepEqual(bridge.calls.map((call) => call.operation), ["preflight", "signSetLeverage", "signAdjustIsolatedMargin", "signUpsertOrder", "signCancelOrder", "signProtectedIoc"]);
  assert.equal(bridge.calls[2].payload.isBuy, true);
  assert.equal(bridge.calls[2].payload.positionSide, "LONG");
  assert.equal(transport.posts.length, 5);
  assert.doesNotMatch(JSON.stringify({ logs, calls: bridge.calls }), /cccccccc/);
});

test("Python signer refuses mainnet signing without confirmation before SDK import or network activity", () => {
  const bridgePath = fileURLToPath(new URL("./hyperliquid_pair_bridge.py", import.meta.url));
  const environment = { ...process.env };
  delete environment.FMV2_PRODUCTION_CONFIRMED;
  Object.assign(environment, {
    FMV2_AGENT_PRIVATE_KEY: privateKey,
    FMV2_MASTER_ACCOUNT_ADDRESS: source,
    FMV2_TARGET_ACCOUNT_ADDRESS: target,
    FMV2_TESTNET: "false",
    FMV2_ACTION_EXPIRES_AFTER_MS: "5000",
  });
  const child = spawnSync(environment.PYTHON ?? "python", [bridgePath], {
    env: environment,
    input: `${JSON.stringify({ id: "mainnet-gate", operation: "signSetLeverage", payload: { coin: "BTC", leverage: { type: "cross", value: 3 } } })}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const reply = JSON.parse(child.stdout.trim());
  assert.equal(reply.id, "mainnet-gate");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /mainnet signing requires/);
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /cccccccc/);
});

test("Python preflight inventories main plus every HIP-3 DEX, with dex-qualified deduplication", () => {
  const result = runFakePythonHarness(String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("fmv2_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class FakeInfo:
    def __init__(self):
        self.calls = []

    def perp_dexs(self):
        self.calls.append(["perpDexs"])
        return [{"name": ""}, {"name": "hip-a"}, {"name": "hip-b"}, {"name": "hip-a"}]

    def user_state(self, address, dex=""):
        self.calls.append(["clearinghouseState", dex])
        positions = {
            "": [{"position": {"coin": "BTC", "szi": "1"}}],
            "hip-a": [{"position": {"coin": "ETH", "szi": "2"}}, {"position": {"coin": "ETH", "szi": "2"}}],
            "hip-b": [],
        }[dex]
        return {"assetPositions": positions, "marginSummary": {"accountValue": "100"}}

    def frontend_open_orders(self, address, dex=""):
        self.calls.append(["frontendOpenOrders", dex])
        orders = {
            "": [{"coin": "BTC", "oid": 11}],
            "hip-a": [{"coin": "ETH", "oid": 77}, {"coin": "ETH", "oid": 77}],
            "hip-b": [{"coin": "SOL", "oid": 88}],
        }[dex]
        return orders

info = FakeInfo()
result = bridge.collect_all_dex_target_state(info, "0x2222222222222222222222222222222222222222")
print(json.dumps({
    "dexes": result["dexes"],
    "positions": [{"dex": item["dex"], "coin": item["coin"]} for item in result["positions"]],
    "orders": [{"dex": item["dex"], "coin": item["coin"], "oid": item["oid"]} for item in result["openOrders"]],
    "calls": info.calls,
}))
`);
  assert.deepEqual(result.dexes, ["", "hip-a", "hip-b"]);
  assert.deepEqual(result.positions, [{ dex: "", coin: "BTC" }, { dex: "hip-a", coin: "hip-a:ETH" }]);
  assert.deepEqual(result.orders, [{ dex: "", coin: "BTC", oid: 11 }, { dex: "hip-a", coin: "hip-a:ETH", oid: 77 }, { dex: "hip-b", coin: "hip-b:SOL", oid: 88 }]);
  assert.deepEqual(result.calls, [
    ["perpDexs"],
    ["clearinghouseState", ""], ["frontendOpenOrders", ""],
    ["clearinghouseState", "hip-a"], ["frontendOpenOrders", "hip-a"],
    ["clearinghouseState", "hip-b"], ["frontendOpenOrders", "hip-b"],
  ]);
});

test("exclusive target preflight sees HIP-3 positions and retains HIP-3 orders for cleanup", () => {
  const result = runFakePythonHarness(String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("fmv2_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class FakeInfo:
    def __init__(self, position=False, order=False):
        self.position = position
        self.order = order
        self.calls = []

    def perp_dexs(self):
        self.calls.append(["perpDexs"])
        return [{"name": "hip-a"}]

    def user_state(self, address, dex=""):
        self.calls.append(["clearinghouseState", dex])
        positions = [{"position": {"coin": "ETH", "szi": "1"}}] if self.position and dex == "hip-a" else []
        return {"assetPositions": positions, "marginSummary": {"accountValue": "100"}}

    def frontend_open_orders(self, address, dex=""):
        self.calls.append(["frontendOpenOrders", dex])
        return [{"coin": "ETH", "oid": 77}] if self.order and dex == "hip-a" else []

def signer_for(info):
    signer = object.__new__(bridge.HyperliquidPairSigner)
    signer.info = info
    signer._load_sdk = lambda: {}
    signer.target_address = "0x2222222222222222222222222222222222222222"
    signer.master_address = "0x1111111111111111111111111111111111111111"
    signer.exclusive_target = True
    signer.adopt_existing = False
    signer.preflight_complete = False
    return signer

position_info = FakeInfo(position=True)
position_signer = signer_for(position_info)
try:
    position_signer.preflight({})
except bridge.BridgeError as error:
    position_error = str(error)
else:
    raise SystemExit("HIP-3 position unexpectedly passed exclusive preflight")

order_info = FakeInfo(order=True)
order_signer = signer_for(order_info)
order_result = order_signer.preflight({})
print(json.dumps({
    "positionError": position_error,
    "positionPreflightComplete": position_signer.preflight_complete,
    "positionCalls": position_info.calls,
    "exclusiveOrders": order_result["openOrders"],
    "orderDexes": order_result["queriedDexes"],
    "orderPreflightComplete": order_signer.preflight_complete,
    "orderCalls": order_info.calls,
}))
`);
  assert.match(result.positionError, /existing positions/);
  assert.equal(result.positionPreflightComplete, false);
  assert.deepEqual(result.positionCalls, [
    ["perpDexs"],
    ["clearinghouseState", ""], ["frontendOpenOrders", ""],
    ["clearinghouseState", "hip-a"], ["frontendOpenOrders", "hip-a"],
  ]);
  assert.deepEqual(result.exclusiveOrders, [{ coin: "hip-a:ETH", oid: 77, dex: "hip-a" }]);
  assert.deepEqual(result.orderDexes, ["", "hip-a"]);
  assert.equal(result.orderPreflightComplete, true);
  assert.deepEqual(result.orderCalls, [
    ["perpDexs"],
    ["clearinghouseState", ""], ["frontendOpenOrders", ""],
    ["clearinghouseState", "hip-a"], ["frontendOpenOrders", "hip-a"],
  ]);
});

test("a failed HIP-3 target query revokes preflight and causes zero action posts", async () => {
  const harness = runFakePythonHarness(String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("fmv2_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class FailingInfo:
    def __init__(self):
        self.calls = []

    def perp_dexs(self):
        self.calls.append(["perpDexs"])
        return [{"name": "hip-a"}]

    def user_state(self, address, dex=""):
        self.calls.append(["clearinghouseState", dex])
        return {"assetPositions": [], "marginSummary": {"accountValue": "100"}}

    def frontend_open_orders(self, address, dex=""):
        self.calls.append(["frontendOpenOrders", dex])
        if dex == "hip-a":
            raise RuntimeError("synthetic HIP-3 order query failure")
        return []

signer = object.__new__(bridge.HyperliquidPairSigner)
signer.info = FailingInfo()
signer._load_sdk = lambda: {}
signer.target_address = "0x2222222222222222222222222222222222222222"
signer.master_address = "0x1111111111111111111111111111111111111111"
signer.exclusive_target = True
signer.adopt_existing = False
signer.preflight_complete = True
try:
    signer.preflight({})
except bridge.BridgeError as error:
    print(json.dumps({"error": str(error), "preflightComplete": signer.preflight_complete, "calls": signer.info.calls}))
else:
    raise SystemExit("preflight unexpectedly succeeded")
`);
  assert.match(harness.error, /target all-DEX preflight query failed/);
  assert.equal(harness.preflightComplete, false);
  assert.deepEqual(harness.calls, [
    ["perpDexs"],
    ["clearinghouseState", ""], ["frontendOpenOrders", ""],
    ["clearinghouseState", "hip-a"], ["frontendOpenOrders", "hip-a"],
  ]);

  class RejectingPreflightSigner {
    constructor() { this.calls = []; }
    async request(operation) {
      this.calls.push(operation);
      if (operation === "preflight") throw new Error("target all-DEX preflight query failed");
      throw new Error(`unexpected signing operation: ${operation}`);
    }
  }

  const bridge = new RejectingPreflightSigner();
  const transport = new FakeTransport();
  const port = new HyperliquidLiveExecutionPort({ pairId: "p1", sourceAddress: source, targetAddress: target, bridge });
  port.attachActionTransport(transport);
  await assert.rejects(port.registerPair(), /all-DEX preflight/);
  assert.deepEqual(bridge.calls, ["preflight"]);
  assert.equal(transport.posts.length, 0);
});
