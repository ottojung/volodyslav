/**
 * Shared migration decision type definitions.
 */

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */

/**
 * @typedef {{ kind: 'keep' }} KeepDecision
 * @typedef {{ kind: 'override', value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} OverrideDecision
 * @typedef {{ kind: 'invalidate', provenance: 'explicit' | 'propagated' }} InvalidateDecision
 * @typedef {{ kind: 'delete' }} DeleteDecision
 * @typedef {"up-to-date" | "potentially-outdated"} CreatedFreshness
 * @typedef {{ kind: 'create', nodeKeyString: string, value: (nodeKey: NodeIdentifier) => Promise<ComputedValue>, freshness: CreatedFreshness }} CreateDecision
 * @typedef {KeepDecision | OverrideDecision | InvalidateDecision | DeleteDecision | CreateDecision} Decision
 */

module.exports = {};
