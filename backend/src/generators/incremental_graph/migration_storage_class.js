/**
 * MigrationStorageClass - accumulates decisions for each materialized node
 * and validates propagation rules.
 */

const {
    makeNodeIdentifier,
    deriveInputEdges,
    ReplicaStateInvariantError,
} = require("./database");
const {
    makeDecisionConflictError,
    makeGetMissingNodeError,
    makeUndecidedNodesError,
    makeCreateExistingNodeError,
    makeInvalidMigrationDecisionError,
} = require("./migration_errors");
const {
    checkSchemaCompatibility,
    assertKeepInputPositionsCompatible,
    resolveSourceNodeKeyFromIndex,
} = require("./migration_storage_schema");
const {
    readValidDependents,
    propagateDeletes,
} = require("./migration_storage_dependencies");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */

/** @typedef {import('./migration_decisions').KeepDecision} KeepDecision */
/** @typedef {import('./migration_decisions').ReplaceDecision} ReplaceDecision */
/** @typedef {import('./migration_decisions').InvalidateDecision} InvalidateDecision */
/** @typedef {import('./migration_decisions').DeleteDecision} DeleteDecision */
/** @typedef {import('./migration_decisions').CreatedFreshness} CreatedFreshness */
/** @typedef {import('./migration_decisions').CreateDecision} CreateDecision */
/** @typedef {import('./migration_decisions').Decision} Decision */
/** @typedef {import('./migration_target_keys').TargetKeyView} TargetKeyView */

/**
 * MigrationStorage class.
 * Accumulates decisions for each materialized node and validates propagation rules.
 */
class MigrationStorageClass {
    /**
     * @private
     * @type {ReadableMigrationStorage}
     */
    prevStorage;

    /**
     * @private
     * @type {Map<NodeIdentifier, Decision>}
     */
    decisions;

    /**
     * @private
     * @type {string}
     */
    _fingerprint;

    /**
     * @private
     * @type {number}
     */
    _nextIndex;

    /**
     * @private
     * @type {Map<string, string>}
     */
    _identifiersKeysIndex;

    /** @type {import('./database/graph_scheme').GraphScheme} */
    oldGraphScheme;

    /** @type {import('./database/graph_scheme').GraphScheme} */
    newGraphScheme;

    /** @type {import('./database/identifier_lookup').IdentifierLookup} */
    oldLookup;

    /**
     * The source materialization in target NodeKey representation.
     * @type {TargetKeyView}
     */
    targetKeyView;

    /**
     * @param {ReadableMigrationStorage} prevStorage
     * @param {Map<NodeName, CompiledNode>} newHeadIndex
     * @param {NodeIdentifier[]} materializedNodes
     * @param {string} fingerprint - The database fingerprint for identifier allocation.
     * @param {number} lastNodeIndex - The current last_node_index watermark.
     * @param {import('./database/graph_scheme').GraphScheme} oldGraphScheme
     * @param {import('./database/graph_scheme').GraphScheme} newGraphScheme
     * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
     * @param {TargetKeyView} targetKeyView
     */
    constructor(prevStorage, newHeadIndex, materializedNodes, fingerprint, lastNodeIndex, oldGraphScheme, newGraphScheme, oldLookup, targetKeyView) {
        this.prevStorage = prevStorage;
        this.newHeadIndex = newHeadIndex;
        this.materializedNodes = new Set(materializedNodes);
        this.decisions = new Map();
        this._fingerprint = fingerprint;
        this._nextIndex = lastNodeIndex + 1;
        this._identifiersKeysIndex = targetKeyView.index;
        this._sourceIdentifiersKeysIndex = buildIdentifiersKeysIndex(oldLookup);
        this._transport = targetKeyView.nodeKeyString;
        this.oldGraphScheme = oldGraphScheme;
        this.newGraphScheme = newGraphScheme;
        this.oldLookup = oldLookup;
        this.targetKeyView = targetKeyView;
    }

    /**
     * Return the target key index, pre-built from the source replica's identifier
     * lookup transported through the source->target codec.
     * @private
     * @returns {Map<string, string>}
     */
    _getIdentifiersKeysIndex() {
        return this._identifiersKeysIndex;
    }

    /**
     * Return the source key index, pre-built from the source replica's identifier
     * lookup as that replica persists it.
     * @private
     * @returns {Map<string, string>}
     */
    _getSourceIdentifiersKeysIndex() {
        return this._sourceIdentifiersKeysIndex;
    }

    /**
     * Read the previous-version value for a node.
     * The return type is not ComputedValue because the type may have changed in the new schema,
     * and it's up to the migration callback to handle it.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<{}>}
     */
    async get(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        const value = await this.prevStorage.values.get(nodeKey);
        if (value === undefined) {
            throw new ReplicaStateInvariantError("migration get", "has no cached value", String(nodeKey));
        }
        return value;
    }

    /**
     * Check whether a node is in the previous-version materialized set S.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<boolean>}
     */
    async has(nodeKey) {
        return this.materializedNodes.has(nodeKey);
    }

    /**
     * Assign a KEEP decision to a node.
     * Idempotent if the same decision already exists.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<void>}
     */
    async keep(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        const identifiersKeysIndex = this._getIdentifiersKeysIndex();
        await checkSchemaCompatibility(nodeKey, this.newHeadIndex, identifiersKeysIndex, this.decisions);
        await assertKeepInputPositionsCompatible(
            nodeKey,
            identifiersKeysIndex,
            this._getSourceIdentifiersKeysIndex(),
            this.oldGraphScheme,
            this.newGraphScheme,
            this._transport
        );
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "keep") return;
            throw makeDecisionConflictError(nodeKey, existing.kind, "keep");
        }
        this.decisions.set(nodeKey, { kind: "keep" });
    }

    /**
     * Assign a REPLACE decision to a node, stating that its stored semantic value
     * is being replaced at the migration cut.
     *
     * `incremental-graph-journal-migrations.md` §11 makes this the explicit
     * decision for a genuine semantic value replacement of an already-materialized
     * source node: it preserves the materialization's `NodeIdentifier` and its
     * `createdAt`, assigns the migration publication time as the new occurrence's
     * `modifiedAt`, and authors a new `ValueEvent(reason="migration")`. A
     * representation-only change of the same semantic value is not this decision;
     * that is the canonical whole-history format codec plus `keep`.
     *
     * A second replacement of the same node is ambiguous about which value the
     * new occurrence should carry, so §11a.1 rejects it exactly as it rejects a
     * different decision family for the same node.
     *
     * @param {NodeIdentifier} nodeKey
     * @param {(nodeKey: NodeIdentifier) => Promise<ComputedValue>} value
     * @returns {Promise<void>}
     */
    async replace(nodeKey, value) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        const identifiersKeysIndex = this._getIdentifiersKeysIndex();
        await checkSchemaCompatibility(nodeKey, this.newHeadIndex, identifiersKeysIndex, this.decisions);
        await assertKeepInputPositionsCompatible(
            nodeKey,
            identifiersKeysIndex,
            this._getSourceIdentifiersKeysIndex(),
            this.oldGraphScheme,
            this.newGraphScheme,
            this._transport
        );
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            throw makeDecisionConflictError(nodeKey, existing.kind, "replace");
        }
        this.decisions.set(nodeKey, { kind: "replace", value });
    }

    /**
     * Assign an INVALIDATE decision to a node.
     * Idempotent if the same decision already exists.
     *
     * `incremental-graph-journal-migrations.md` §11a.2 makes this a genuine
     * node-scoped semantic invalidation of exactly the named node: it does not
     * assign a decision to any dependent. A kept dependent stays materialized and
     * becomes recursively stale through its stale input during replay, so no
     * dependent conflict is raised merely because the invalidated node is its
     * input. Journal 3 represents propagated freshness separately from semantic
     * migration decisions.
     *
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<void>}
     */
    async invalidate(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        const identifiersKeysIndex = this._getIdentifiersKeysIndex();
        await checkSchemaCompatibility(nodeKey, this.newHeadIndex, identifiersKeysIndex, this.decisions);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "invalidate") {
                return;
            }
            throw makeDecisionConflictError(nodeKey, existing.kind, "invalidate");
        }
        this.decisions.set(nodeKey, { kind: "invalidate", provenance: "explicit" });
    }

    /**
     * Assign a DELETE decision to a node.
     * Idempotent if the same decision already exists.
     * DELETE propagation to validity propagation is deferred to finalize().
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<void>}
     */
    async delete(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "delete") return;
            if (existing.kind === "invalidate" && existing.provenance === "propagated") {
                this.decisions.set(nodeKey, { kind: "delete" });
                return;
            }
            throw makeDecisionConflictError(nodeKey, existing.kind, "delete");
        }
        this.decisions.set(nodeKey, { kind: "delete" });
    }

    /**
     * Generate a deterministic identifier using the database fingerprint and
     * a monotonic index. Collisions are impossible with fingerprint-prefixed
     * identifiers within a single database.
     * @returns {NodeIdentifier}
     */
    _generateIdentifier() {
        const index = this._nextIndex++;
        return makeNodeIdentifier(this._fingerprint, index);
    }

    /**
     * Create a new node in the new schema version with an initial value.
     * The node must NOT exist in the previous version (use replace() instead).
     * The node must exist in the new schema.
     * The identifier is auto-generated deterministically using the database
     * fingerprint and a monotonic index.
     * The caller chooses whether the created cached node is clean or stale.
     * @param {import('./database/types').NodeKeyString} nodeKeyString - The semantic key JSON string
     * @param {(nodeKey: NodeIdentifier) => Promise<ComputedValue>} value
     * @param {CreatedFreshness} freshness
     * @returns {Promise<void>}
     */
    async create(nodeKeyString, value, freshness) {
        if (freshness !== "up-to-date" && freshness !== "potentially-outdated") {
            throw makeInvalidMigrationDecisionError(`Cannot create node ${nodeKeyString}: freshness must be "up-to-date" or "potentially-outdated"`);
        }
        const keyStr = String(nodeKeyString);

        // §11a.1: a create whose target key equals `rewriteNodeKey(Ks)` for any
        // materialized source node collides with transported source state, so the
        // comparison is made against the transported target keys and not against the
        // source spelling the source replica persists.
        for (const [, existingKey] of this._identifiersKeysIndex.entries()) {
            if (existingKey === keyStr) {
                throw makeCreateExistingNodeError(nodeKeyString);
            }
        }

        for (const [existingNodeKey, decision] of this.decisions) {
            if (decision.kind === "create" && String(decision.nodeKeyString) === keyStr) {
                throw makeDecisionConflictError(existingNodeKey, "create", "create");
            }
        }

        const nodeKey = this._generateIdentifier();
        this.decisions.set(nodeKey, { kind: "create", nodeKeyString: keyStr, value, freshness });
        const identifiersKeysIndex = this._getIdentifiersKeysIndex();
        try { await checkSchemaCompatibility(nodeKey, this.newHeadIndex, identifiersKeysIndex, this.decisions); }
        catch (err) { this.decisions.delete(nodeKey); throw err; }
    }

    /**
     * Iterate over all nodes in S (previous-version materialized set).
     * @returns {AsyncGenerator<NodeIdentifier>}
     */
    async *listMaterializedNodes() {
        for (const nodeKey of this.materializedNodes) {
            yield nodeKey;
        }
    }

    /**
     * Get the dependency keys of a node from the previous-version graph.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<readonly NodeIdentifier[]>}
     */
    async getDependencyKeys(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        return deriveInputEdges(this.oldGraphScheme, this.oldLookup, nodeKey);
    }

    /**
     * Get the outgoing validity frontier of a node from the previous-version graph.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<readonly NodeIdentifier[]>}
     */
    async listValidDependents(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        return readValidDependents(nodeKey, this.prevStorage);
    }

    /**
     * Resolve a node identifier to the parsed node key used by the previous
     * replica or created during migration, if possible.
     * Checks decisions first (for create entries), then falls through to
     * the old identifiers_keys_map.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<import('./database/node_key').NodeKey | undefined>}
     */
    async resolveNodeKey(nodeKey) {
        return resolveSourceNodeKeyFromIndex(nodeKey, this._sourceIdentifiersKeysIndex, this.decisions);
    }

    /**
     * Return the max allocated local index during this migration.
     * Used to compute the new last_node_index for the target replica.
     * @returns {number}
     */
    getMaxAllocatedIndex() {
        return this._nextIndex - 1;
    }

    /**
     * Finalize the migration: propagate DELETE decisions through dependents,
     * and verify every node in S has exactly one decision.
     * @returns {Promise<Map<NodeIdentifier, Decision>>}
     */
    async finalize() {
        await propagateDeletes({
            materializedNodes: this.materializedNodes,
            decisions: this.decisions,
            newGraphScheme: this.newGraphScheme,
            targetKeyView: this.targetKeyView,
        });
        this._checkCompleteness();
        return this.decisions;
    }

    /**
     * Verify every node in S has exactly one decision.
     * @private
     * @returns {void}
     */
    _checkCompleteness() {
        const undecided = [];
        for (const nodeKey of this.materializedNodes) {
            if (!this.decisions.has(nodeKey)) {
                undecided.push(nodeKey);
            }
        }
        if (undecided.length > 0) {
            throw makeUndecidedNodesError(undecided);
        }
    }
}

/**
 * Build an identifiers keys index map (idString → nodeKeyString) from a
 * parsed identifier lookup.
 * @param {import('./database/identifier_lookup').IdentifierLookup} lookup
 * @returns {Map<string, string>}
 */
function buildIdentifiersKeysIndex(lookup) {
    const index = new Map();
    for (const [idString, nodeKeyString] of lookup.idToKey.entries()) {
        index.set(idString, String(nodeKeyString));
    }
    return index;
}

module.exports = {
    MigrationStorageClass,
};
