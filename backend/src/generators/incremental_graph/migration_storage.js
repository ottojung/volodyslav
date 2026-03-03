/**
 * MigrationStorage module.
 * Provides a strict decision-based API for migrating previous-version graph data.
 */

const { stringToNodeKeyString } = require("./database");
const { deserializeNodeKey } = require("./node_key");
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

/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */

/**
 * @typedef {{ kind: 'keep' }} KeepDecision
 * @typedef {{ kind: 'override', value: (nodeKey: NodeKeyString) => Promise<ComputedValue> }} OverrideDecision
 * @typedef {{ kind: 'invalidate' }} InvalidateDecision
 * @typedef {{ kind: 'delete' }} DeleteDecision
 * @typedef {{ kind: 'create', value: (nodeKey: NodeKeyString) => Promise<ComputedValue> }} CreateDecision
 * @typedef {KeepDecision | OverrideDecision | InvalidateDecision | DeleteDecision | CreateDecision} Decision
 */

/**
 * Checks whether a node is compatible with the new schema.
 * @param {NodeKeyString} nodeKey
 * @param {Map<NodeName, CompiledNode>} newHeadIndex
 * @returns {void}
 */
function checkSchemaCompatibility(nodeKey, newHeadIndex) {
    const { head, args } = deserializeNodeKey(nodeKey);
    const arity = args.length;
    const compiled = newHeadIndex.get(head);
    if (!compiled) {
        throw makeSchemaCompatibilityError(
            nodeKey,
            `head '${head}' does not exist in the new schema`
        );
    }
    if (compiled.arity !== arity) {
        throw makeSchemaCompatibilityError(
            nodeKey,
            `arity mismatch: node has ${arity} argument(s) but new schema expects ${compiled.arity}`
        );
    }
}

/**
 * Reads the inputs list for a node from the previous storage.
 * Throws MissingDependencyMetadataError if the record is absent or corrupted.
 * @param {NodeKeyString} nodeKey
 * @param {SchemaStorage} prevStorage
 * @returns {Promise<NodeKeyString[]>}
 */
async function readInputsRecord(nodeKey, prevStorage) {
    const record = await prevStorage.inputs.get(nodeKey);
    if (!record) {
        throw makeMissingDependencyMetadataError(nodeKey);
    }
    return record.inputs.map(stringToNodeKeyString);
}

/**
 * Reads the dependents list for a node from the previous storage.
 * @param {NodeKeyString} nodeKey
 * @param {SchemaStorage} prevStorage
 * @returns {Promise<NodeKeyString[]>}
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
     * @type {SchemaStorage}
     */
    prevStorage;

    /**
     * @private
     * @type {Map<NodeName, CompiledNode>}
     */
    newHeadIndex;

    /**
     * The set of all nodes materialized in the previous version (scope S).
     * @private
     * @type {Set<NodeKeyString>}
     */
    materializedNodes;

    /**
     * Accumulated per-node decisions.
     * @private
     * @type {Map<NodeKeyString, Decision>}
     */
    decisions;

    /**
     * @param {SchemaStorage} prevStorage
     * @param {Map<NodeName, CompiledNode>} newHeadIndex
     * @param {NodeKeyString[]} materializedNodes
     */
    constructor(prevStorage, newHeadIndex, materializedNodes) {
        this.prevStorage = prevStorage;
        this.newHeadIndex = newHeadIndex;
        this.materializedNodes = new Set(materializedNodes);
        this.decisions = new Map();
    }

    /**
     * Read the previous-version value for a node.
     * @param {NodeKeyString} nodeKey
     * @returns {Promise<ComputedValue>}
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
     * @param {NodeKeyString} nodeKey
     * @returns {Promise<boolean>}
     */
    async has(nodeKey) {
        return this.materializedNodes.has(nodeKey);
    }

    /**
     * Assign a KEEP decision to a node.
     * Idempotent if the same decision already exists.
     * @param {NodeKeyString} nodeKey
     * @returns {Promise<void>}
     */
    async keep(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        checkSchemaCompatibility(nodeKey, this.newHeadIndex);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            if (existing.kind === "keep") return;
            throw makeDecisionConflictError(nodeKey, existing.kind, "keep");
        }
        this.decisions.set(nodeKey, { kind: "keep" });
    }

    /**
     * Assign an OVERRIDE decision to a node with a new value.
     * @param {NodeKeyString} nodeKey
     * @param {(nodeKey: NodeKeyString) => Promise<ComputedValue>} value
     * @returns {Promise<void>}
     */
    async override(nodeKey, value) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        checkSchemaCompatibility(nodeKey, this.newHeadIndex);
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
     * @param {NodeKeyString} nodeKey
     * @returns {Promise<void>}
     */
    async invalidate(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        checkSchemaCompatibility(nodeKey, this.newHeadIndex);
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
     * @param {NodeKeyString} nodeKey
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
     * Create a new node in the new schema version with an initial value.
     * The node must NOT exist in the previous version (use override() instead).
     * The node must exist in the new schema.
     * The new node is created as up-to-date with the provided value and empty inputs.
     * @param {NodeKeyString} nodeKey
     * @param {(nodeKey: NodeKeyString) => Promise<ComputedValue>} value
     * @returns {Promise<void>}
     */
    async create(nodeKey, value) {
        if (this.materializedNodes.has(nodeKey)) {
            throw makeCreateExistingNodeError(nodeKey);
        }
        checkSchemaCompatibility(nodeKey, this.newHeadIndex);
        const existing = this.decisions.get(nodeKey);
        if (existing !== undefined) {
            throw makeDecisionConflictError(nodeKey, existing.kind, "create");
        }
        this.decisions.set(nodeKey, { kind: "create", value });
    }

    /**
     * Iterate over all nodes in S (previous-version materialized set).
     * @returns {AsyncGenerator<NodeKeyString>}
     */
    async *listMaterializedNodes() {
        for (const nodeKey of this.materializedNodes) {
            yield nodeKey;
        }
    }

    /**
     * Get the inputs of a node from the previous-version graph.
     * @param {NodeKeyString} nodeKey
     * @returns {Promise<readonly NodeKeyString[]>}
     */
    async getInputs(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        return readInputsRecord(nodeKey, this.prevStorage);
    }

    /**
     * Get the dependents of a node from the previous-version graph.
     * @param {NodeKeyString} nodeKey
     * @returns {Promise<readonly NodeKeyString[]>}
     */
    async getDependents(nodeKey) {
        if (!this.materializedNodes.has(nodeKey)) {
            throw makeGetMissingNodeError(nodeKey);
        }
        return readDependents(nodeKey, this.prevStorage);
    }

    /**
     * Propagate INVALIDATE to all dependents of a node recursively.
     * Stops at already-invalidated or deleted nodes.
     * Throws on conflict with KEEP/OVERRIDE decisions.
     * @private
     * @param {NodeKeyString} nodeKey
     * @param {Set<NodeKeyString>} visited
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
            checkSchemaCompatibility(dep, this.newHeadIndex);
            this.decisions.set(dep, { kind: "invalidate" });
            await this._propagateInvalidate(dep, visited);
        }
    }

    /**
     * Finalize the migration: propagate DELETE decisions, check fan-in constraints,
     * and verify every node in S has exactly one decision.
     * @returns {Promise<Map<NodeKeyString, Decision>>}
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
        /** @type {NodeKeyString[]} */
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
        /** @type {NodeKeyString[]} */
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
 * @param {SchemaStorage} prevStorage
 * @param {Map<NodeName, CompiledNode>} newHeadIndex
 * @param {NodeKeyString[]} materializedNodes
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
