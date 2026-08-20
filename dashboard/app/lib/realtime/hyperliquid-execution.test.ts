import assert from "node:assert/strict";
import test from "node:test";
import {
  DisabledHyperliquidExecutionAdapter,
  HyperliquidExecutionAdapter,
  hyperliquidClientOrderId,
} from "./hyperliquid-execution";

const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const privateKey = `0x${"12".repeat(32)}`;

test("uses a deterministic 128-bit Hyperliquid client order id", () => {
  const first = hyperliquidClientOrderId(source, "77");
  assert.match(first, /^0x[a-f0-9]{32}$/);
  assert.equal(first, hyperliquidClientOrderId(source.toUpperCase(), "77"));
  assert.notEqual(first, hyperliquidClientOrderId(source, "78"));
});

test("live execution is disabled by default and mainnet needs a separate confirmation", () => {
  assert.ok(HyperliquidExecutionAdapter.fromEnvironment({}) instanceof DisabledHyperliquidExecutionAdapter);
  const mainnet = HyperliquidExecutionAdapter.fromEnvironment({
    HYPERLIQUID_ENABLED: "true",
    HYPERLIQUID_TESTNET: "false",
    HYPERLIQUID_AGENT_PRIVATE_KEY: privateKey,
    HYPERLIQUID_MASTER_ACCOUNT_ADDRESS: target,
    HYPERLIQUID_TARGETS_JSON: JSON.stringify({ [source]: target }),
  });
  assert.equal(mainnet.enabled, false);
});

test("rejects sharing one target account across whale wallets", () => {
  assert.throws(() => HyperliquidExecutionAdapter.fromEnvironment({
    HYPERLIQUID_ENABLED: "true",
    HYPERLIQUID_TESTNET: "true",
    HYPERLIQUID_AGENT_PRIVATE_KEY: privateKey,
    HYPERLIQUID_MASTER_ACCOUNT_ADDRESS: target,
    HYPERLIQUID_TARGETS_JSON: JSON.stringify({
      [source]: target,
      "0x3333333333333333333333333333333333333333": target,
    }),
  }), /distinct/);
});

test("rejects a target whose queried account differs from the actual master or vault order route", () => {
  assert.throws(() => HyperliquidExecutionAdapter.fromEnvironment({
    HYPERLIQUID_ENABLED: "true",
    HYPERLIQUID_TESTNET: "true",
    HYPERLIQUID_AGENT_PRIVATE_KEY: privateKey,
    HYPERLIQUID_MASTER_ACCOUNT_ADDRESS: target,
    HYPERLIQUID_TARGETS_JSON: JSON.stringify({
      [source]: { accountAddress: "0x3333333333333333333333333333333333333333" },
    }),
  }), /must be the configured master account/);

  assert.throws(() => HyperliquidExecutionAdapter.fromEnvironment({
    HYPERLIQUID_ENABLED: "true",
    HYPERLIQUID_TESTNET: "true",
    HYPERLIQUID_AGENT_PRIVATE_KEY: privateKey,
    HYPERLIQUID_MASTER_ACCOUNT_ADDRESS: target,
    HYPERLIQUID_TARGETS_JSON: JSON.stringify({
      [source]: {
        accountAddress: "0x3333333333333333333333333333333333333333",
        vaultAddress: "0x4444444444444444444444444444444444444444",
      },
    }),
  }), /must be the same address/);
});

test("accepts a direct master target and an explicitly matched vault target", () => {
  const direct = HyperliquidExecutionAdapter.fromEnvironment({
    HYPERLIQUID_ENABLED: "true",
    HYPERLIQUID_TESTNET: "true",
    HYPERLIQUID_AGENT_PRIVATE_KEY: privateKey,
    HYPERLIQUID_MASTER_ACCOUNT_ADDRESS: target,
    HYPERLIQUID_TARGETS_JSON: JSON.stringify({ [source]: { accountAddress: target } }),
  });
  assert.equal(direct.enabled, true);
  direct.close?.();

  const vault = "0x3333333333333333333333333333333333333333";
  const delegated = HyperliquidExecutionAdapter.fromEnvironment({
    HYPERLIQUID_ENABLED: "true",
    HYPERLIQUID_TESTNET: "true",
    HYPERLIQUID_AGENT_PRIVATE_KEY: privateKey,
    HYPERLIQUID_MASTER_ACCOUNT_ADDRESS: target,
    HYPERLIQUID_TARGETS_JSON: JSON.stringify({ [source]: { accountAddress: vault, vaultAddress: vault } }),
  });
  assert.equal(delegated.enabled, true);
  delegated.close?.();
});
