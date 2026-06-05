/**
 * MigrationStorage module.
 * Provides a strict decision-based API for migrating previous-version graph data.
 */

const crypto = require("crypto");
const { basicString } = require("../../random");
const { deserializeNodeKey, nodeIdentifierToString, stringToNodeIdentifier, stringToNodeKeyString, unsafeStringToNodeIdentifier, IDENTIFIERS_KEY } = require("./database");
const {
    makeDecisionConflictError,
    makeOverrideConflictError,
    makeSchemaCompatibilityError,
    makeGetMissingNodeError,
    makeGetMissingValueError,
    makeMissingDependencyMetadataError,
    makeUndecidedNodesError,
    makePartialDeleteFanInError,
    makeCreateExistingNodeError,
} = require("./migration_errors");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */

/**
 * Read-only database view used by migration decision logic.
 * Migration callbacks never write directly to the previous replica.
 * @typedef {object} ReadableMigrationStorage
 * @property {{ get(nodeKey: NodeIdentifier): Promise<ComputedValue | undefined> }} values
 * @property {{ get(nodeKey: NodeIdentifier): Promise<import('./database/types').Freshness | undefined> }} freshness
 * @property {{ get(nodeKey: NodeIdentifier): Promise<import('./database/root_database').InputsRecord | undefined> }} inputs
 * @property {{ get(nodeKey: NodeIdentifier): Promise<NodeIdentifier[] | undefined> }} revdeps
 * @property {{ get(nodeKey: NodeIdentifier): Promise<number | undefined> }} counters
 * @property {{ get(nodeKey: NodeIdentifier): Promise<import('./database/types').TimestampRecord | undefined> }} timestamps
 * @property {{ get(key: string): Promise<unknown> }} global
 * @property {(operations: import('./database/types').DatabaseBatchOperation[]) => Promise<void>} [batch]
 */

/**
 * @typedef {{ kind: 'keep' }} KeepDecision
 * @typedef {{ kind: 'override', value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} OverrideDecision
 * @typedef {{ kind: 'invalidate' }} InvalidateDecision
 * @typedef {{ kind: 'delete' }} DeleteDecision
 * @typedef {{ kind: 'create', nodeKeyString: string, value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} CreateDecision
 * @typedef {KeepDecision | OverrideDecision | InvalidateDecision | DeleteDecision | CreateDecision} Decision
 */




/**
 * Resolve a node key to its parsed form using an indexed
 * `identifiers_keys_map` record or a create decision.
 *
 * Decisions take priority so that created nodes can also be resolved before
 * finalize().
 *
 * @param {NodeIdentifier} nodeKey
 * @param {Map<string, string>} identifiersKeysIndex - idString -> nodeKeyString
 * @param {Map<NodeIdentifier, Decision>} [decisions]
 * @returns {import('./database/node_key').NodeKey | undefined}
 */
function resolveNodeKeyFromIndex(nodeKey, identifiersKeysIndex, decisions) {
    const nodeKeyStr = String(nodeKey);

    const decision = decisions?.get(nodeKey);
    if (decision?.kind === "create" && decision.nodeKeyString !== undefined) {
        return deserializeNodeKey(stringToNodeKeyString(decision.nodeKeyString));
    }

    const nodeKeyString = identifiersKeysIndex.get(nodeKeyStr);
    if (nodeKeyString === undefined) return undefined;
    return deserializeNodeKey(stringToNodeKeyString(nodeKeyString));
}

/**
 * Checks whether a node is compatible with the new schema.
 * Requires the node to be resolvable through the identifiers keys map or
 * through a create decision's stored nodeKeyString.
 * @param {NodeIdentifier} nodeKey
 * @param {Map<NodeName, CompiledNode>} newHeadIndex
 * @param {Map<string, string>} identifiersKeysIndex - idString -> nodeKeyString
 * @param {Map<NodeIdentifier, Decision>} [decisions]
 * @returns {Promise<void>}
 */
async function checkSchemaCompatibility(nodeKey, newHeadIndex, identifiersKeysIndex, decisions) {
    const parsed = resolveNodeKeyFromIndex(nodeKey, identifiersKeysIndex, decisions);
    if (parsed === undefined) return;

    const head = parsed.head;
    const arity = parsed.args.length;
    const compiled = newHeadIndex.get(head);
    if (!compiled) throw makeSchemaCompatibilityError(nodeKey, `head '${head}' does not exist in the new schema`);
    if (compiled.arity !== arity) throw makeSchemaCompatibilityError(nodeKey, `arity mismatch: node has ${arity} argument(s) but new schema expects ${compiled.arity}`);
}

/**
 * Reads the inputs list for a node from the previous storage.
 * Throws MissingDependencyMetadataError if the record is absent or corrupted.
 * @param {NodeIdentifier} nodeKey
 * @param {ReadableMigrationStorage} prevStorage
 * @returns {Promise<NodeIdentifier[]>}
 */
async function readInputsRecord(nodeKey, prevStorage) {
    const record = await prevStorage.inputs.get(nodeKey);
    if (!record) {
        throw makeMissingDependencyMetadataError(nodeKey);
    }
    return record.inputs.map(unsafeStringToNodeIdentifier);
}

/**
 * Reads the dependents list for a node from the previous storage.
 * @param {NodeIdentifier} nodeKey
 * @param {ReadableMigrationStorage} prevStorage
 * @returns {Promise<NodeIdentifier[]>}
 */
async function readDependents(nodeKey, prevStorage) {
    const dependents = await prevStorage.revdeps.get(nodeKey);
    return dependents !== undefined ? dependents : [];
}

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
     * @type {undefined | (() => number)}
     */
    _generator;

    /**
     * @private
     * @type {undefined | Map<string, string>}
     */
    _identifiersKeysIndex;

    /**
     * @param {ReadableMigrationStorage} prevStorage
     * @param {Map<NodeName, CompiledNode>} newHeadIndex
     * @param {NodeIdentifier[]} materializedNodes
     */
    constructor(prevStorage, newHeadIndex, materializedNodes) {
        this.prevStorage = prevStorage;
        this.newHeadIndex = newHeadIndex;
        this.materializedNodes = new Set(materializedNodes);
        this.decisions = new Map();
        this._generator = undefined;
        this._identifiersKeysIndex = undefined;
    }

    /**
     * Lazily load and index the persisted identifiers_keys_map record.
     *
     * This avoids repeatedly calling `prevStorage.global.get(IDENTIFIERS_KEY)`
     * and linearly scanning the returned array during schema compatibility
     * checks.
     * @private
     * @returns {Promise<Map<string, string>>}
     */
    async _getIdentifiersKeysIndex() {
        if (this._identifiersKeysIndex !== undefined) return this._identifiersKeysIndex;

        /** @type {Map<string, string>} */
        const index = new Map();
        const entries = this.prevStorage.global !== undefined
            ? await this.prevStorage.global.get(IDENTIFIERS_KEY)
            : undefined;
        if (Array.isArray(entries)) {
            for (const [id, nodeKeyJson] of entries) {
                index.set(String(id), String(nodeKeyJson));
            }
        }

        this._identifiersKeysIndex = index;
        return index;
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
            throw makeGetMissingValueError(nodeKey);
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
        await checkSchemaCompatibility(nodeKey, this.newHeadIndex, await this._getIdentifiersKeysIndex(), this.decisions);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "keep") return;
            throw makeDecisionConflictError(nodeKey, existing.kind, "keep");
        }
        this.decisions.set(nodeKey, { kind: "keep" });
    }

    /**
     * Assign an OVERRIDE decision to a node with a new value.
     * @param {NodeIdentifier} nodeKey
     * @param {(nodeKey: NodeIdentifier) => Promise<ComputedValue>} value
     * @returns {Promise<void>}
     */
    async override(nodeKey, value) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        await checkSchemaCompatibility(nodeKey, this.newHeadIndex, await this._getIdentifiersKeysIndex(), this.decisions);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "override") {
                throw makeOverrideConflictError(nodeKey);
            }
            throw makeDecisionConflictError(nodeKey, existing.kind, "override");
        }
        this.decisions.set(nodeKey, { kind: "override", value });
        await this._propagateInvalidate(nodeKey, new Set());
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
        const identifiersKeysIndex = await this._getIdentifiersKeysIndex();
        await checkSchemaCompatibility(nodeKey, this.newHeadIndex, identifiersKeysIndex, this.decisions);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "invalidate") return;
            throw makeDecisionConflictError(nodeKey, existing.kind, "invalidate");
        }
        this.decisions.set(nodeKey, { kind: "invalidate" });
        await this._propagateInvalidate(nodeKey, new Set());
    }

    /**
     * Assign a DELETE decision to a node.
     * Idempotent if the same decision already exists.
     * DELETE propagation to dependents is deferred to finalize().
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
            throw makeDecisionConflictError(nodeKey, existing.kind, "delete");
        }
        this.decisions.set(nodeKey, { kind: "delete" });
    }

    /**
     * Initialise the shared capabilities counter from identifiers_keys_map.
     * Called exactly once, on the first _generateIdentifier call.
     * @private
     * @returns {Promise<() => number>}
     */
    async _initSeed() {
        if (this._generator !== undefined) {
            return this._generator;
        }
        const existingEntries = await this.prevStorage.global.get(IDENTIFIERS_KEY);
        const entriesJson = Array.isArray(existingEntries)
            ? JSON.stringify([...existingEntries].sort())
            : JSON.stringify([]);
        const hash = crypto.createHash("sha256").update("identifiers_keys_map:" + entriesJson).digest();
        let counter = hash.readUInt32BE(0) >>> 0;
        const generator = () => counter++;
        this._generator = generator;
        return generator;
    }

    /**
     * Generate a deterministic identifier using the shared capabilities.
     * Retries on collision with no bound — 26^9 space guarantees eventual success.
     * @returns {Promise<NodeIdentifier>}
     */
    async _generateIdentifier() {
        const existingEntries = await this.prevStorage.global.get(IDENTIFIERS_KEY);

        /** @type {Set<string>} */
        const existingIds = new Set();
        if (Array.isArray(existingEntries)) {
            for (const [id] of existingEntries) {
                existingIds.add(String(id));
            }
        }
        for (const key of this.decisions.keys()) {
            existingIds.add(nodeIdentifierToString(key));
        }

        const generate = await this._initSeed();
        const capabilities = {
            seed: { generate }
        };

        let id;
        do {
            id = basicString(capabilities, 9);
        } while (existingIds.has(id));

        return stringToNodeIdentifier(id);
    }

    /**
     * Create a new node in the new schema version with an initial value.
     * The node must NOT exist in the previous version (use override() instead).
     * The node must exist in the new schema.
     * The identifier is auto-generated deterministically from the existing
     * identifiers_keys_map and the accumulated decisions so far.
     * The new node is created as up-to-date with the provided value and empty inputs.
     * @param {import('./database/types').NodeKeyString} nodeKeyString - The semantic key JSON string
     * @param {(nodeKey: NodeIdentifier) => Promise<ComputedValue>} value
     * @returns {Promise<void>}
     */
    async create(nodeKeyString, value) {
        const keyStr = String(nodeKeyString);

        const existingEntries = await this.prevStorage.global.get(IDENTIFIERS_KEY);
        if (Array.isArray(existingEntries)) {
            for (const [, existingKey] of existingEntries) {
                if (String(existingKey) === keyStr) {
                    throw makeCreateExistingNodeError(nodeKeyString);
                }
            }
        }

        for (const [existingNodeKey, decision] of this.decisions) {
            if (decision.kind === "create" && String(decision.nodeKeyString) === keyStr) {
                throw makeDecisionConflictError(existingNodeKey, "create", "create");
            }
        }

        await this._initSeed();
        const nodeKey = await this._generateIdentifier();
        this.decisions.set(nodeKey, { kind: "create", nodeKeyString: keyStr, value });
        const identifiersKeysIndex = await this._getIdentifiersKeysIndex();
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
     * Get the inputs of a node from the previous-version graph.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<readonly NodeIdentifier[]>}
     */
    async getInputs(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        return readInputsRecord(nodeKey, this.prevStorage);
    }

    /**
     * Get the dependents of a node from the previous-version graph.
     * @param {NodeIdentifier} nodeKey
     * @returns {Promise<readonly NodeIdentifier[]>}
     */
    async getDependents(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        return readDependents(nodeKey, this.prevStorage);
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
        const identifiersKeysIndex = await this._getIdentifiersKeysIndex();
        return resolveNodeKeyFromIndex(nodeKey, identifiersKeysIndex, this.decisions);
    }

    /**
     * Propagate INVALIDATE to all dependents of a node recursively.
     * Stops at already-invalidated or deleted nodes.
     * Throws on conflict with KEEP/OVERRIDE decisions.
     * @private
     * @param {NodeIdentifier} nodeKey
     * @param {Set<NodeIdentifier>} visited
     * @returns {Promise<void>}
     */
    async _propagateInvalidate(nodeKey, visited) {
        if (visited.has(nodeKey)) return;
        visited.add(nodeKey);
        const dependents = await readDependents(nodeKey, this.prevStorage);
        for (const dep of dependents) {
            if (!this.materializedNodes.has(dep)) continue;
            const existing = this.decisions.get(dep);
            if (existing !== undefined) {
                if (existing.kind === "delete" || existing.kind === "invalidate") {
                    continue;
                }
                throw makeDecisionConflictError(dep, existing.kind, "invalidate");
            }
            const identifiersKeysIndex = await this._getIdentifiersKeysIndex();
            await checkSchemaCompatibility(dep, this.newHeadIndex, identifiersKeysIndex, this.decisions);
            this.decisions.set(dep, { kind: "invalidate" });
            await this._propagateInvalidate(dep, visited);
        }
    }

    /**
     * Finalize the migration: propagate DELETE decisions, check fan-in constraints,
     * and verify every node in S has exactly one decision.
     * @returns {Promise<Map<NodeIdentifier, Decision>>}
     */
    async finalize() {
        await this._propagateDeletesAndCheckFanIn();
        this._checkCompleteness();
        return this.decisions;
    }

    /**
     * BFS propagation of DELETE to dependents whose all inputs are deleted,
     * followed by a fan-in violation scan.
     * @private
     * @returns {Promise<void>}
     */
    async _propagateDeletesAndCheckFanIn() {
        /** @type {NodeIdentifier[]} */
        const queue = [];
        for (const [nodeKey, decision] of this.decisions) {
            if (decision.kind === "delete") {
                queue.push(nodeKey);
            }
        }
        let head = 0;
        while (head < queue.length) {
            // noUncheckedIndexedAccess requires an explicit undefined guard
            const nodeKey = queue[head];
            head++;
            if (nodeKey === undefined) break;
            const dependents = await readDependents(nodeKey, this.prevStorage);
            for (const dep of dependents) {
                if (!this.materializedNodes.has(dep)) continue;
                if (this.decisions.get(dep)?.kind === "delete") continue;
                const inputs = await readInputsRecord(dep, this.prevStorage);
                const allDeleted = inputs.every(
                    (inp) => this.decisions.get(inp)?.kind === "delete"
                );
                if (!allDeleted) continue;
                const existing = this.decisions.get(dep);
                if (existing !== undefined) {
                    throw makeDecisionConflictError(dep, existing.kind, "delete");
                }
                this.decisions.set(dep, { kind: "delete" });
                queue.push(dep);
            }
        }
        // Fan-in violation: any non-deleted node reachable from a deleted node
        // that was not itself auto-deleted means its inputs are only partially deleted.
        for (const [nodeKey, decision] of this.decisions) {
            if (decision.kind !== "delete") continue;
            const dependents = await readDependents(nodeKey, this.prevStorage);
            for (const dep of dependents) {
                if (!this.materializedNodes.has(dep)) continue;
                if (this.decisions.get(dep)?.kind === "delete") continue;
                const inputs = await readInputsRecord(dep, this.prevStorage);
                throw makePartialDeleteFanInError(dep, inputs);
            }
        }
    }

    /**
     * Verify every node in S has exactly one decision.
     * @private
     * @returns {void}
     */
    _checkCompleteness() {
        /** @type {NodeIdentifier[]} */
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
 * Factory function to create a MigrationStorage instance.
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeName, CompiledNode>} newHeadIndex
 * @param {NodeIdentifier[]} materializedNodes
 * @returns {MigrationStorageClass}
 */
function makeMigrationStorage(prevStorage, newHeadIndex, materializedNodes) {
    return new MigrationStorageClass(prevStorage, newHeadIndex, materializedNodes);
}

/**
 * Type guard for MigrationStorage.
 * @param {unknown} object
 * @returns {object is MigrationStorageClass}
 */
function isMigrationStorage(object) {
    return object instanceof MigrationStorageClass;
}

/** @typedef {MigrationStorageClass} MigrationStorage */

module.exports = {
    makeMigrationStorage,
    isMigrationStorage,
};
