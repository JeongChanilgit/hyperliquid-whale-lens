import { MAX_TRACKED_WHALES, normalizeAddress } from "./domain.mjs";
import { FaithfulPairActor } from "./pair-actor.mjs";

const clone = (value) => structuredClone(value);

export class FiveWhaleFaithfulMirrorEngine {
  constructor({ pairs, executionFactory, actorConfig = {}, now = Date.now, log = () => {} }) {
    if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > MAX_TRACKED_WHALES) {
      throw new Error(`Faithful mirror requires 1-${MAX_TRACKED_WHALES} source-target pairs`);
    }
    if (typeof executionFactory !== "function") throw new Error("executionFactory is required");
    const sourceSet = new Set();
    const targetSet = new Set();
    this.actors = new Map();
    this.executions = new Map();
    this.pairBySource = new Map();
    this.pairByTarget = new Map();
    this.running = false;
    this.now = now;
    this.log = log;
    for (const raw of pairs) {
      const pairId = String(raw.pairId ?? `pair-${this.actors.size + 1}`);
      const sourceAddress = normalizeAddress(raw.sourceAddress);
      const targetAddress = normalizeAddress(raw.targetAddress);
      if (sourceSet.has(sourceAddress)) throw new Error(`Duplicate source address: ${sourceAddress}`);
      if (targetSet.has(targetAddress)) throw new Error(`Duplicate target address: ${targetAddress}`);
      sourceSet.add(sourceAddress);
      targetSet.add(targetAddress);
      const execution = executionFactory({ pairId, sourceAddress, targetAddress, pair: clone(raw) });
      this.executions.set(pairId, execution);
      const actor = new FaithfulPairActor({
        pairId,
        sourceAddress,
        targetAddress,
        execution,
        config: { ...actorConfig, ...(raw.actorConfig ?? {}) },
        now,
        log: (entry) => log({ engine: "FMV2", ...entry }),
      });
      this.actors.set(pairId, actor);
      this.pairBySource.set(sourceAddress, pairId);
      this.pairByTarget.set(targetAddress, pairId);
    }
  }

  async bootstrapPair(pairId, payload) {
    const actor = this.#actor(pairId);
    const snapshot = await actor.bootstrap(payload);
    this.running = true;
    return snapshot;
  }

  async bootstrapAll(payloadByPair) {
    const entries = [...this.actors.entries()];
    for (const [pairId, actor] of entries) {
      const payload = payloadByPair[pairId];
      if (!payload) throw new Error(`Missing bootstrap payload for ${pairId}`);
      await actor.bootstrap(payload);
    }
    this.running = true;
    return this.snapshot();
  }

  async onSourceOrder(sourceAddress, update) {
    const actor = this.#actorBySource(sourceAddress);
    return actor.onSourceOrder(update);
  }

  onSourceFill(sourceAddress, fill) {
    this.#actorBySource(sourceAddress).onSourceFill(fill);
  }

  onTargetFill(targetAddress, fill) {
    this.#actorByTarget(targetAddress).onTargetFill(fill);
  }

  onTargetOrder(targetAddress, update) {
    this.#actorByTarget(targetAddress).onTargetOrder(update);
  }

  attachActionTransport(pairId, transport) {
    const execution = this.executions.get(String(pairId));
    if (!execution) throw new Error(`Missing execution port for ${pairId}`);
    if (typeof execution.attachActionTransport === "function") execution.attachActionTransport(transport);
    else if (typeof execution.bindActionTransport === "function") execution.bindActionTransport(transport.postAction ?? transport);
    else throw new Error(`Execution port for ${pairId} cannot accept an action transport`);
  }

  onSourceSnapshot(sourceAddress, snapshot) {
    this.#actorBySource(sourceAddress).onSourceSnapshot(snapshot);
  }

  onTargetSnapshot(targetAddress, snapshot) {
    this.#actorByTarget(targetAddress).onTargetSnapshot(snapshot);
  }

  async syncSourceOrders(sourceAddress, openOrders) {
    return this.#actorBySource(sourceAddress).syncSourceOrders(openOrders);
  }

  async syncTargetOrders(targetAddress, openOrders) {
    return this.#actorByTarget(targetAddress).syncTargetOrders(openOrders);
  }

  async whenIdle() {
    await Promise.all([...this.actors.values()].map((actor) => actor.whenIdle()));
  }

  snapshot() {
    return {
      running: this.running,
      pairCount: this.actors.size,
      maximumPairCount: MAX_TRACKED_WHALES,
      generatedAt: this.now(),
      pairs: Object.fromEntries([...this.actors.entries()].map(([pairId, actor]) => [pairId, actor.snapshot()])),
    };
  }

  async emergencyStop(reason = "EMERGENCY_STOP") {
    await Promise.all([...this.actors.values()].map((actor) => actor.emergencyStop(reason)));
    this.running = false;
  }

  stop() {
    for (const actor of this.actors.values()) actor.stop();
    this.running = false;
  }

  #actor(pairId) {
    const actor = this.actors.get(String(pairId));
    if (!actor) throw new Error(`Unknown pair id: ${pairId}`);
    return actor;
  }

  #actorBySource(sourceAddress) {
    const source = normalizeAddress(sourceAddress);
    const pairId = this.pairBySource.get(source);
    if (!pairId) throw new Error(`Unknown source address: ${source}`);
    return this.#actor(pairId);
  }

  #actorByTarget(targetAddress) {
    const target = normalizeAddress(targetAddress);
    const pairId = this.pairByTarget.get(target);
    if (!pairId) throw new Error(`Unknown target address: ${target}`);
    return this.#actor(pairId);
  }
}
