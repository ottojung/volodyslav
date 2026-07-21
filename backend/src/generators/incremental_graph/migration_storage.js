/**
 * MigrationStorage module.
 * Provides a strict decision-based API for migrating previous-version graph data.
 *
 * Public facade — delegates to MigrationStorageClass and sibling modules.
 */

const { MigrationStorageClass } = require("./migration_storage_class");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */

/** @typedef {import('./migration_decisions').KeepDecision} KeepDecision */
/** @typedef {import('./migration_decisions').OverrideDecision} OverrideDecision */
/** @typedef {import('./migration_decisions').InvalidateDecision} InvalidateDecision */
/** @typedef {import('./migration_decisions').DeleteDecision} DeleteDecision */
/** @typedef {import('./migration_decisions').CreatedFreshness} CreatedFreshness */
/** @typedef {import('./migration_decisions').CreateDecision} CreateDecision */
/** @typedef {import('./migration_decisions').Decision} Decision */


/**
 * Read-only database view used by migration decision logic.
 * Migration callbacks never write directly to the previous replica.
 * @typedef {object} ReadableMigrationStorage
 * @property {{ get(nodeKey: NodeIdentifier): Promise<ComputedValue | undefined> }} values
 * @property {{ get(nodeKey: NodeIdentifier): Promise<import('./database/types').Freshness | undefined> }} freshness
 * @property {{ get(nodeKey: NodeIdentifier): Promise<NodeIdentifier[] | undefined> }} valid
 * @property {{ get(nodeKey: NodeIdentifier): Promise<import('./database/types').TimestampRecord | undefined> }} timestamps
 * @property {{ get(nodeKey: NodeIdentifier): Promise<import('./database/value_clock').ValueClock | undefined> }} valueClocks
 * @property {{ get(key: string): Promise<unknown> }} global
 * @property {(operations: import('./database/types').DatabaseBatchOperation[]) => Promise<void>} [batch]
 */

/**
 * Factory function to create a MigrationStorage instance.
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<import('./types').NodeName, import('./types').CompiledNode>} newHeadIndex
 * @param {NodeIdentifier[]} materializedNodes
 * @param {string} fingerprint - The database fingerprint for identifier allocation.
 * @param {number} lastNodeIndex - The current last_node_index watermark.
 * @param {import('./database/graph_scheme').GraphScheme} oldGraphScheme
 * @param {import('./database/graph_scheme').GraphScheme} newGraphScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @returns {MigrationStorageClass}
 */
function makeMigrationStorage(prevStorage, newHeadIndex, materializedNodes, fingerprint, lastNodeIndex, oldGraphScheme, newGraphScheme, oldLookup) {
    if (oldGraphScheme === undefined || newGraphScheme === undefined || oldLookup === undefined) {
        throw new Error(
            "makeMigrationStorage: oldGraphScheme, newGraphScheme, and oldLookup are required. " +
            "Test callers must build real graph schemes and identifier lookups."
        );
    }
    return new MigrationStorageClass(prevStorage, newHeadIndex, materializedNodes, fingerprint, lastNodeIndex, oldGraphScheme, newGraphScheme, oldLookup);
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
