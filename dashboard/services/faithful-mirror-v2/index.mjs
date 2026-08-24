import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlAuditStore, normalizeRecoveryCheckpoint, sanitizeForAudit } from "./audit-store.mjs";
import { loadConfig, publicConfig } from "./config.mjs";
import { createControlServer } from "./control-server.mjs";
import { HyperliquidLiveExecutionPort, JsonLineSignerBridge } from "./live-port.mjs";
import { createPaperMirrorSystem } from "./paper-runtime.mjs";
import { createLiveMirrorSystem, HyperliquidMirrorRuntime } from "./runtime.mjs";

const ARM_CONFIRMATION = "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS";
const ARM_TTL_MS = 60_000;
const LIVE_STOPPED = "STOPPED_UNARMED";

const lifecycleError = (message, statusCode = 409) => {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
};

const asErrorSummary = (error) => ({ name: error?.name ?? "Error", message: error?.message ?? "operation failed" });

const defaultBuildSystem = ({ config, env, log }) => {
  if (config.mode === "PAPER") {
    return createPaperMirrorSystem({
      pairs: config.pairs,
      testnet: config.testnet,
      actorConfig: config.actorConfig,
      venueOptions: config.paper,
      ...config.runtime,
      log,
    });
  }
  const executionFactory = ({ pairId, sourceAddress, targetAddress, index }) => {
    const signerEnvironment = {
      FMV2_AGENT_PRIVATE_KEY: config.live.agentPrivateKeys[index],
      FMV2_MASTER_ACCOUNT_ADDRESS: config.live.masterAccountAddress,
      FMV2_TARGET_ACCOUNT_ADDRESS: targetAddress,
      FMV2_TESTNET: String(config.testnet),
      FMV2_ACTION_EXPIRES_AFTER_MS: String(config.live.actionExpiresAfterMs),
      FMV2_EXCLUSIVE_TARGET_ACCOUNT: String(config.live.exclusiveTargetAccount),
      FMV2_ADOPT_EXISTING_TARGET_STATE: String(config.live.adoptExistingTargetState),
      ...(env.FMV2_PRODUCTION_CONFIRMED ? { FMV2_PRODUCTION_CONFIRMED: env.FMV2_PRODUCTION_CONFIRMED } : {}),
    };
    const bridge = new JsonLineSignerBridge({
      pythonPath: config.live.pythonPath,
      bridgePath: config.live.bridgePath,
      environment: signerEnvironment,
    });
    return new HyperliquidLiveExecutionPort({ pairId, sourceAddress, targetAddress, bridge, log });
  };
  const system = createLiveMirrorSystem({ pairs: config.pairs, executionFactory, actorConfig: config.actorConfig, log });
  return {
    ...system,
    runtime: new HyperliquidMirrorRuntime({ engine: system.engine, pairs: config.pairs, testnet: config.testnet, ...config.runtime, log }),
  };
};

const cancelledShadowOrders = async (system, emit) => {
  const executions = system?.engine?.executionByPair;
  if (!(executions instanceof Map)) return;
  for (const [pairId, execution] of executions) {
    if (!(execution?.orders instanceof Map) || typeof execution.cancelOrder !== "function") continue;
    for (const [targetOrderId, order] of execution.orders) {
      if (["CANCELED", "FILLED", "REJECTED", "TERMINAL"].includes(String(order?.status ?? "").toUpperCase())) continue;
      try {
        await execution.cancelOrder({ pairId, targetOrderId: String(targetOrderId), reason: "SERVICE_STOP" });
        emit({ type: "SHADOW_ORDER_CANCELLED_ON_STOP", pairId, targetOrderId: String(targetOrderId), at: Date.now() });
      } catch (error) {
        emit({ type: "SHADOW_ORDER_CANCEL_FAILED", pairId, targetOrderId: String(targetOrderId), error: asErrorSummary(error), at: Date.now() });
      }
    }
  }
};

const recoveryFromSystem = ({ config, sessionId, state, system, previous, now }) => {
  const runtimeRecovery = system?.runtime?.recoveryCheckpoint?.() ?? system?.runtime?.getRecoveryCheckpoint?.();
  const snapshot = system?.engine?.snapshot?.() ?? {};
  const priorPairs = new Map((previous?.pairs ?? []).map((pair) => [pair.pairId, pair]));
  const runtimePairs = new Map((runtimeRecovery?.pairs ?? []).map((pair) => [pair.pairId, pair]));
  const recoveryPairs = config.pairs.map((pair) => {
    const prior = priorPairs.get(pair.pairId) ?? {};
    const runtimePair = runtimePairs.get(pair.pairId) ?? {};
    const actor = snapshot?.pairs?.[pair.pairId] ?? {};
    const sourceOrderToTargetCloid = Object.fromEntries((actor.targetOrderState ?? [])
      .filter((order) => order?.sourceOrderId && order?.targetOrderId)
      .map((order) => [String(order.sourceOrderId), String(order.targetOrderId)]));
    return {
      ...prior,
      ...runtimePair,
      pairId: pair.pairId,
      sourceAddress: pair.sourceAddress,
      targetAddress: pair.targetAddress,
      sourceOrderToTargetCloid: { ...(prior.sourceOrderToTargetCloid ?? {}), ...sourceOrderToTargetCloid },
      accountMode: runtimePair.accountMode ?? actor.accountMode ?? prior.accountMode ?? "UNKNOWN",
      lastSourceSnapshotAt: runtimePair.lastSourceSnapshotAt ?? actor.sourceSnapshot?.receivedAt ?? prior.lastSourceSnapshotAt ?? now(),
      lastTargetSnapshotAt: runtimePair.lastTargetSnapshotAt ?? actor.targetSnapshot?.receivedAt ?? prior.lastTargetSnapshotAt ?? now(),
      killSwitch: state === "KILLED" || actor.killed === true || prior.killSwitch === true,
      sessionId,
    };
  });
  return normalizeRecoveryCheckpoint({ sessionId, mode: config.mode, state, pairs: config.pairs, recoveryPairs, writtenAt: now() });
};

export const createServiceLifecycle = ({ config, auditStore, env = process.env, now = Date.now, buildSystem = defaultBuildSystem } = {}) => {
  if (!config || !auditStore) throw new Error("Service lifecycle requires config and auditStore");
  const secretValues = [config.control?.token, ...(config.live?.agentPrivateKeys ?? [])].filter(Boolean);
  const sessionId = randomUUID();
  let state = config.mode === "LIVE" ? LIVE_STOPPED : "STOPPED";
  let armedUntil = null;
  let system = null;
  let timer = null;
  let previousRecovery = null;
  let initialized = false;
  let serial = Promise.resolve();

  const emit = (event) => {
    void auditStore.record({ sessionId, ...sanitizeForAudit(event, secretValues) }).catch(() => {});
  };
  const queue = (operation) => {
    const next = serial.then(operation, operation);
    serial = next.catch(() => {});
    return next;
  };
  const clearTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const isArmed = () => {
    if (config.mode !== "LIVE") return true;
    if (armedUntil != null && now() >= armedUntil) {
      armedUntil = null;
      if (state === "ARMED") state = LIVE_STOPPED;
      emit({ type: "LIVE_ARM_EXPIRED", at: now() });
    }
    return armedUntil != null && now() < armedUntil;
  };
  const persist = async () => {
    const snapshot = {
      schemaVersion: 1,
      sessionId,
      state,
      at: now(),
      config: publicConfig(config),
      system: system?.engine?.snapshot?.() ?? null,
    };
    await auditStore.writeSnapshot(snapshot);
    await auditStore.writeRecoveryCheckpoint(recoveryFromSystem({ config, sessionId, state, system, previous: previousRecovery, now }));
  };
  const status = async () => ({
    service: "faithful-mirror-v2",
    mode: config.mode,
    state,
    running: state === "RUNNING",
    killed: state === "KILLED",
    armed: isArmed(),
    armExpiresAt: armedUntil,
    sessionId,
    config: publicConfig(config),
    recoveryAvailable: previousRecovery != null,
    snapshot: system?.engine?.snapshot?.() ?? null,
  });
  const initialize = async () => {
    if (initialized) return;
    previousRecovery = await auditStore.loadRecoveryCheckpoint();
    initialized = true;
    emit({ type: "SERVICE_INITIALIZED", mode: config.mode, recoveredCheckpoint: previousRecovery != null, at: now() });
    await persist();
  };

  return {
    initialize,
    status,
    async arm({ confirmation } = {}) {
      return queue(async () => {
        await initialize();
        if (config.mode !== "LIVE") throw lifecycleError("arm is only available in LIVE mode", 400);
        if (state === "KILLED") throw lifecycleError("service is killed; create a new process to resume");
        if (confirmation !== ARM_CONFIRMATION) throw lifecycleError("live arm confirmation is required", 400);
        armedUntil = now() + ARM_TTL_MS;
        if (state !== "RUNNING") state = "ARMED";
        emit({ type: "LIVE_ARMED", armExpiresAt: armedUntil, at: now() });
        await persist();
        return { state, armExpiresAt: armedUntil };
      });
    },
    async start() {
      return queue(async () => {
        await initialize();
        if (state === "RUNNING") return { state };
        if (state === "KILLED") throw lifecycleError("service is killed; create a new process to resume");
        if (config.mode === "LIVE" && !isArmed()) throw lifecycleError("LIVE start requires an unexpired arm", 403);
        state = "STARTING";
        await persist();
        try {
          system = await buildSystem({ config, env, recovery: previousRecovery, log: emit });
          const restore = system?.runtime?.restoreRecoveryCheckpoint ?? system?.restoreRecoveryCheckpoint;
          if (previousRecovery?.state === "RUNNING" && typeof restore !== "function" && config.mode === "LIVE") {
            state = "PAIR_RECOVERY_BLOCKED";
            await persist();
            throw lifecycleError("LIVE recovery checkpoint requires a runtime recovery hook", 503);
          }
          if (previousRecovery && typeof restore === "function") await restore.call(system.runtime ?? system, previousRecovery);
          await system?.runtime?.start?.();
          if (!system?.runtime?.start && typeof system?.start === "function") await system.start();
          state = "RUNNING";
          if (config.mode === "LIVE") armedUntil = null;
          timer = setInterval(() => { void persist().catch(() => {}); }, config.audit.snapshotIntervalMs);
          timer.unref?.();
          emit({ type: "SERVICE_STARTED", mode: config.mode, at: now() });
          await persist();
          return { state };
        } catch (error) {
          if (state !== "PAIR_RECOVERY_BLOCKED") state = "DEGRADED";
          emit({ type: "SERVICE_START_FAILED", error: asErrorSummary(error), at: now() });
          await persist();
          throw error;
        }
      });
    },
    async stop() {
      return queue(async () => {
        await initialize();
        if (state === "KILLED") return { state };
        state = "STOPPING";
        clearTimer();
        await cancelledShadowOrders(system, emit);
        try {
          await system?.runtime?.stop?.();
          if (!system?.runtime?.stop) await system?.stop?.();
        } finally {
          system = null;
          state = config.mode === "LIVE" ? LIVE_STOPPED : "STOPPED";
          armedUntil = null;
          emit({ type: "SERVICE_STOPPED", at: now() });
          await persist();
          await auditStore.flush();
        }
        return { state };
      });
    },
    async kill() {
      return queue(async () => {
        await initialize();
        clearTimer();
        const executions = system?.engine?.executionByPair;
        if (executions instanceof Map) {
          for (const [pairId, execution] of executions) {
            try { await execution?.onUnresolvedResidual?.({ pairId, killSwitchRequested: true, reason: "GLOBAL_KILL" }); }
            catch (error) { emit({ type: "KILL_SWITCH_NOTIFICATION_FAILED", pairId, error: asErrorSummary(error), at: now() }); }
          }
        }
        await cancelledShadowOrders(system, emit);
        await system?.runtime?.stop?.();
        if (!system?.runtime?.stop) await system?.stop?.();
        system = null;
        armedUntil = null;
        state = "KILLED";
        emit({ type: "SERVICE_KILLED", at: now() });
        await persist();
        await auditStore.flush();
        return { state };
      });
    },
    async reconcile() {
      return queue(async () => {
        await initialize();
        if (state !== "RUNNING") throw lifecycleError("reconcile requires a running service");
        if (config.mode === "LIVE" && !isArmed()) throw lifecycleError("LIVE reconcile requires an unexpired arm", 403);
        const reconcile = system?.runtime?.reconcile ?? system?.reconcile;
        if (typeof reconcile !== "function") throw lifecycleError("runtime does not expose a safe reconcile hook", 501);
        const result = await reconcile.call(system.runtime ?? system);
        emit({ type: "SERVICE_RECONCILED", at: now() });
        await persist();
        return result ?? { state };
      });
    },
    async close() {
      await this.stop();
      await auditStore.close();
    },
  };
};

export const main = async () => {
  const config = await loadConfig();
  const auditStore = new JsonlAuditStore({
    ...config.audit,
    secretValues: [config.control.token, ...config.live.agentPrivateKeys],
  });
  const lifecycle = createServiceLifecycle({ config, auditStore });
  await lifecycle.initialize();
  const control = createControlServer({
    lifecycle,
    auditStore,
    host: config.control.host,
    port: config.control.port,
    controlToken: config.control.token,
  });
  await control.listen();
  const shutdown = async (reason) => {
    try {
      await lifecycle.stop();
      await control.close();
      await auditStore.close();
    } finally {
      process.exitCode = reason ? 1 : 0;
    }
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("uncaughtException", () => { void lifecycle.kill().finally(() => void shutdown("uncaughtException")); });
  process.once("unhandledRejection", () => { void lifecycle.kill().finally(() => void shutdown("unhandledRejection")); });
  if (config.mode === "PAPER" && config.autoStart) {
    try { await lifecycle.start(); }
    catch { process.exitCode = 1; }
  }
  return { lifecycle, control };
};

export const isDirectInvocation = ({ argv1 = process.argv[1], moduleUrl = import.meta.url } = {}) => {
  if (!argv1) return false;
  const invokedPath = resolve(argv1);
  const modulePath = fileURLToPath(moduleUrl);
  return process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
};

if (isDirectInvocation()) {
  main().catch(() => { process.exitCode = 1; });
}
