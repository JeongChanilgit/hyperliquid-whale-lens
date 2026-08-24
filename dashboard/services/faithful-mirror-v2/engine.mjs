import { MAX_TRACKED_WHALES, normalizeAddress } from "./domain.mjs";
import { FaithfulPairActor } from "./pair-actor.mjs";

export class FiveWhaleFaithfulMirrorEngine {
  constructor({ pairs, executionFactory, actorConfig = {}, log = () => {} }) {
    if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > MAX_TRACKED_WHALES) {
      throw new Error(`Faithful mirror requires 1-${MAX_TRACKED_WHALES} source-target pairs`);
    }
    const sources = new Set();
    const targets = new Set();
    this.actorsByPair = new Map();
    this.pairIdBySource = new Map();
    this.pairIdByTarget = new Map();
    this.executionByPair = new Map();
    this.log = log;
    for (const [index, input] of pairs.entries()) {
      const pairId = String(input.pairId ?? `pair-${index + 1}`);
      if (this.actorsByPair.has(pairId)) throw new Error(`Duplicate pairId: ${pairId}`);
      const sourceAddress = normalizeAddress(input.sourceAddress);
      const targetAddress = normalizeAddress(input.targetAddress);
      if (sourceAddress === targetAddress) throw new Error(`Source and target must differ for pair ${pairId}`);
      if (sources.has(sourceAddress)) throw new Error(`Duplicate source whale: ${sourceAddress}`);
      if (targets.has(targetAddress)) throw new Error(`Duplicate target account: ${targetAddress}`);
      sources.add(sourceAddress);
      targets.add(targetAddress);
      const execution = executionFactory({ pairId, sourceAddress, targetAddress, index });
      const actor = new FaithfulPairActor({
        pairId,
        sourceAddress,
        targetAddress,
        execution,
        config: actorConfig,
        log: (event) => this.log({ ...event, pairId, sourceAddress, targetAddress }),
      });
      this.actorsByPair.set(pairId, actor);
      this.executionByPair.set(pairId, execution);
      this.pairIdBySource.set(sourceAddress, pairId);
      this.pairIdByTarget.set(targetAddress, pairId);
    }
  }

  attachActionTransport(pairId, transport) {
    const execution = this.executionByPair.get(String(pairId));
    if (!execution) throw new Error(`Unknown pair: ${pairId}`);
    if (typeof execution.attachActionTransport !== "function") throw new Error(`Pair ${pairId} execution port does not support action transport`);
    execution.attachActionTransport(transport);
  }

  async bootstrapPair(pairId, payload) {
    const actor = this.actorsByPair.get(String(pairId));
    if (!actor) throw new Error(`Unknown pair: ${pairId}`);
    await actor.bootstrap(payload);
  }

  restoreOrderOwnership(pairId, payload) {
    const normalizedPairId = String(pairId);
    const actor = this.actorsByPair.get(normalizedPairId);
    const execution = this.executionByPair.get(normalizedPairId);
    if (!actor || !execution) throw new Error(`Unknown pair: ${pairId}`);
    const result = actor.restoreOrderOwnership(payload);
    // The live port needs the validated Cloids before its preflight cleanup;
    // otherwise it would cancel the very order the actor is about to retain.
    execution.restoreOrderOwnership?.({ pairId: normalizedPairId, ...payload });
    return result;
  }

  onSourceSnapshot(sourceAddress, snapshot) {
    const actor = this.#actorBySource(sourceAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    actor.onSourceSnapshot(snapshot);
    return { accepted: true };
  }

  onTargetSnapshot(targetAddress, snapshot) {
    const actor = this.#actorByTarget(targetAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    actor.onTargetSnapshot(snapshot);
    return { accepted: true };
  }

  onSourceFill(sourceAddress, fill) {
    const actor = this.#actorBySource(sourceAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    actor.onSourceFill(fill);
    return { accepted: true };
  }

  onTargetFill(targetAddress, fill) {
    const actor = this.#actorByTarget(targetAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    actor.onTargetFill(fill);
    return { accepted: true };
  }

  async onSourceOrder(sourceAddress, update) {
    const actor = this.#actorBySource(sourceAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    await actor.onSourceOrder(update);
    return { accepted: true };
  }

  onTargetOrder(targetAddress, update) {
    const actor = this.#actorByTarget(targetAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    actor.onTargetOrder(update);
    return { accepted: true };
  }

  async syncSourceOrders(sourceAddress, orders) {
    const actor = this.#actorBySource(sourceAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    await actor.syncSourceOrders(orders);
    return { accepted: true };
  }

  syncTargetOrders(targetAddress, orders) {
    const actor = this.#actorByTarget(targetAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    actor.syncTargetOrders(orders);
    return { accepted: true };
  }

  onCurrentMark(sourceAddress, coin, markPriceUsd) {
    const actor = this.#actorBySource(sourceAddress);
    if (actor.isTerminal()) return { ignored: true, reason: "PAIR_TERMINAL" };
    actor.onCurrentMark(coin, markPriceUsd);
    return { accepted: true };
  }

  isPairTerminal(pairId) {
    const actor = this.actorsByPair.get(String(pairId));
    if (!actor) throw new Error(`Unknown pair: ${pairId}`);
    return actor.isTerminal();
  }

  async whenIdle() {
    await Promise.all([...this.actorsByPair.values()].map((actor) => actor.whenIdle()));
  }

  snapshot() {
    return { pairs: Object.fromEntries([...this.actorsByPair].map(([pairId, actor]) => [pairId, actor.snapshot()])) };
  }

  stop() {
    for (const actor of this.actorsByPair.values()) actor.stop();
    for (const execution of this.executionByPair.values()) execution.close?.();
  }

  #actorBySource(address) {
    const pairId = this.pairIdBySource.get(normalizeAddress(address));
    if (!pairId) throw new Error(`Unknown source whale: ${address}`);
    return this.actorsByPair.get(pairId);
  }

  #actorByTarget(address) {
    const pairId = this.pairIdByTarget.get(normalizeAddress(address));
    if (!pairId) throw new Error(`Unknown target account: ${address}`);
    return this.actorsByPair.get(pairId);
  }

}
