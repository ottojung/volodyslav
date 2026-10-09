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
    makeOverrideConflictError,
    makeGetMissingNodeError,
    makeUndecidedNodesError,
    makeCreateExistingNodeError,
    makeInvalidMigrationDecisionError,
} = require("./migration_errors");
const {
    checkSchemaCompatibility,
    assertKeepInputPositionsCompatible,
    resolveNodeKeyFromIndex,
} = require("./migration_storage_schema");
const {
    readValidDependents,
    propagateInvalidate,
    propagateDeletes,
} = require("./migration_storage_dependencies");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */

/** @typedef {import('./migration_decisions').KeepDecision} KeepDecision */
/** @typedef {import('./migration_decisions').OverrideDecision} OverrideDecision */
/** @typedef {import('./migration_decisions').InvalidateDecision} InvalidateDecision */
/** @typedef {import('./migration_decisions').DeleteDecision} DeleteDecision */
/** @typedef {import('./migration_decisions').CreatedFreshness} CreatedFreshness */
/** @typedef {import('./migration_decisions').CreateDecision} CreateDecision */
/** @typedef {import('./migration_decisions').Decision} Decision */

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
     * @param {ReadableMigrationStorage} prevStorage
     * @param {Map<NodeName, CompiledNode>} newHeadIndex
     * @param {NodeIdentifier[]} materializedNodes
     * @param {string} fingerprint - The database fingerprint for identifier allocation.
     * @param {number} lastNodeIndex - The current last_node_index watermark.
     * @param {import('./database/graph_scheme').GraphScheme} oldGraphScheme
     * @param {import('./database/graph_scheme').GraphScheme} newGraphScheme
     * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
     */
    constructor(prevStorage, newHeadIndex, materializedNodes, fingerprint, lastNodeIndex, oldGraphScheme, newGraphScheme, oldLookup) {
        this.prevStorage = prevStorage;
        this.newHeadIndex = newHeadIndex;
        this.materializedNodes = new Set(materializedNodes);
        this.decisions = new Map();
        this._fingerprint = fingerprint;
        this._nextIndex = lastNodeIndex + 1;
        this._identifiersKeysIndex = buildIdentifiersKeysIndex(oldLookup);
        this.oldGraphScheme = oldGraphScheme;
        this.newGraphScheme = newGraphScheme;
        this.oldLookup = oldLookup;
    }

    /**
     * Return the identifiers keys index, pre-built from oldLookup at
     * construction time.
     * @private
     * @returns {Map<string, string>}
     */
    _getIdentifiersKeysIndex() {
        return this._identifiersKeysIndex;
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
        await assertKeepInputPositionsCompatible(nodeKey, identifiersKeysIndex, this.oldGraphScheme, this.newGraphScheme);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "keep") return;
            throw makeDecisionConflictError(nodeKey, existing.kind, "keep");
        }
        this.decisions.set(nodeKey, { kind: "keep" });
    }

    /**
     * Assign an OVERRIDE decision to a node that rewrites its stored
     * representation while preserving the semantic value.
     *
     * `override()` is a **semantic-preserving representation rewrite**:
     * - It may change the on-disk storage shape (e.g. after a database version
     *   change that alters the serialization format).
     * - It MUST preserve the semantic value as seen by dependents — the
     *   represented value is meaningfully the same as before.
     * - Because the value is semantically unchanged, override() does NOT
     *   propagate invalidation. Dependents that were valid against the old
     *   representation remain valid against the new one.
     *
     * If the migration changes the meaning or value of a node (not just its
     * storage representation), the migration must use `invalidate()` instead
     * of `override()`. This triggers downstream recomputation so dependents
     * observe the changed value.
     *
     * @param {NodeIdentifier} nodeKey
     * @param {(nodeKey: NodeIdentifier) => Promise<ComputedValue>} value
     * @returns {Promise<void>}
     */
    async override(nodeKey, value) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        const identifiersKeysIndex = this._getIdentifiersKeysIndex();
        await checkSchemaCompatibility(nodeKey, this.newHeadIndex, identifiersKeysIndex, this.decisions);
        await assertKeepInputPositionsCompatible(nodeKey, identifiersKeysIndex, this.oldGraphScheme, this.newGraphScheme);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "override") {
                throw makeOverrideConflictError(nodeKey);
            }
            throw makeDecisionConflictError(nodeKey, existing.kind, "override");
        }
        this.decisions.set(nodeKey, { kind: "override", value });
    }

    /**
     * Assign an INVALIDATE decision to a node.
     * Idempotent if the same decision already exists.
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
                this.decisions.set(nodeKey, { kind: "invalidate", provenance: "explicit" });
                return;
            }
            throw makeDecisionConflictError(nodeKey, existing.kind, "invalidate");
        }
        this.decisions.set(nodeKey, { kind: "invalidate", provenance: "explicit" });
        await propagateInvalidate({
            nodeKey,
            visited: new Set(),
            prevStorage: this.prevStorage,
            materializedNodes: this.materializedNodes,
            decisions: this.decisions,
            newHeadIndex: this.newHeadIndex,
            getIdentifiersKeysIndex: () => this._identifiersKeysIndex,
        });
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
     * The node must NOT exist in the previous version (use override() instead).
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

        for (const [, existingKey] of this.oldLookup.idToKey.entries()) {
            if (String(existingKey) === keyStr) {
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
        const identifiersKeysIndex = this._getIdentifiersKeysIndex();
        return resolveNodeKeyFromIndex(nodeKey, identifiersKeysIndex, this.decisions);
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
            oldLookup: this.oldLookup,
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
