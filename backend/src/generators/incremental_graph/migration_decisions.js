/**
 * Shared migration decision type definitions.
 */

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */

/**
 * A genuine semantic value replacement of an already-materialized node.
 *
 * `docs/specs/incremental-graph-journal-migrations.md` §11 makes this the only
 * decision which produces a new occurrence for an existing materialization: it
 * preserves the materialization's `NodeIdentifier` and `createdAt`, assigns the
 * migration publication time as its `modifiedAt`, and authors a new
 * `ValueEvent(reason="migration")`. A representation-only change is not this
 * decision; it is the canonical whole-history codec plus `keep`.
 *
 * @typedef {{ kind: 'replace', value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} ReplaceDecision
 * @typedef {{ kind: 'keep' }} KeepDecision
 * @typedef {{ kind: 'invalidate', provenance: 'explicit' | 'propagated' }} InvalidateDecision
 * @typedef {{ kind: 'delete' }} DeleteDecision
 * @typedef {"up-to-date" | "potentially-outdated"} CreatedFreshness
 * @typedef {{ kind: 'create', nodeKeyString: string, value: (nodeKey: NodeIdentifier) => Promise<ComputedValue>, freshness: CreatedFreshness }} CreateDecision
 * @typedef {KeepDecision | ReplaceDecision | InvalidateDecision | DeleteDecision | CreateDecision} Decision
 */

module.exports = {};
