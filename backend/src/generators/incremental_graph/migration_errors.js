/**
 * Error classes for MigrationStorage operations.
 */

/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/node_key').NodeKey} NodeKey */

/**
 * Thrown when two different decisions are assigned to the same node.
 */
class DecisionConflict extends Error {
    /**
     * @param {NodeIdentifier} nodeKey
     * @param {string} existingKind
     * @param {string} newKind
     */
    constructor(nodeKey, existingKind, newKind) {
        super(
            `Decision conflict for node ${nodeKey}: already has '${existingKind}', cannot set '${newKind}'`
        );
        this.name = "DecisionConflictError";
        this.nodeKey = nodeKey;
        this.existingKind = existingKind;
        this.newKind = newKind;
    }
}

/**
 * @param {NodeIdentifier} nodeKey
 * @param {string} existingKind
 * @param {string} newKind
 * @returns {DecisionConflict}
 */
function makeDecisionConflictError(nodeKey, existingKind, newKind) {
    return new DecisionConflict(nodeKey, existingKind, newKind);
}

/**
 * @param {unknown} object
 * @returns {object is DecisionConflict}
 */
function isDecisionConflict(object) {
    return object instanceof DecisionConflict;
}

/**
 * Thrown when some nodes in S have no decision after the migration callback.
 */
class UndecidedNodes extends Error {
    /**
     * @param {NodeIdentifier[]} undecidedNodes
     */
    constructor(undecidedNodes) {
        super(
            `Migration incomplete: ${undecidedNodes.length} node(s) have no decision: ` +
                undecidedNodes.join(", ")
        );
        this.name = "UndecidedNodesError";
        this.undecidedNodes = undecidedNodes;
    }
}

/**
 * @param {NodeIdentifier[]} undecidedNodes
 * @returns {UndecidedNodes}
 */
function makeUndecidedNodesError(undecidedNodes) {
    return new UndecidedNodes(undecidedNodes);
}

/**
 * @param {unknown} object
 * @returns {object is UndecidedNodes}
 */
function isUndecidedNodes(object) {
    return object instanceof UndecidedNodes;
}

/**
 * Thrown when keep/replace/invalidate is called on a node incompatible with the new schema.
 */
class SchemaCompatibility extends Error {
    /**
     * @param {NodeIdentifier} nodeKey
     * @param {string} reason
     */
    constructor(nodeKey, reason) {
        super(
            `Schema compatibility error for node ${nodeKey}: ${reason}. ` +
                `Use delete() to remove nodes that are incompatible with the new schema.`
        );
        this.name = "SchemaCompatibilityError";
        this.nodeKey = nodeKey;
        this.reason = reason;
    }
}

/**
 * @param {NodeIdentifier} nodeKey
 * @param {string} reason
 * @returns {SchemaCompatibility}
 */
function makeSchemaCompatibilityError(nodeKey, reason) {
    return new SchemaCompatibility(nodeKey, reason);
}

/**
 * @param {unknown} object
 * @returns {object is SchemaCompatibility}
 */
function isSchemaCompatibility(object) {
    return object instanceof SchemaCompatibility;
}

/**
 * Thrown when get/traversal is called on a node not in the previous-version materialized set S.
 */
class GetMissingNode extends Error {
    /**
     * @param {NodeIdentifier} nodeKey
     */
    constructor(nodeKey) {
        super(`Node not found in previous version: ${nodeKey}`);
        this.name = "GetMissingNodeError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {NodeIdentifier} nodeKey
 * @returns {GetMissingNode}
 */
function makeGetMissingNodeError(nodeKey) {
    return new GetMissingNode(nodeKey);
}

/**
 * @param {unknown} object
 * @returns {object is GetMissingNode}
 */
function isGetMissingNode(object) {
    return object instanceof GetMissingNode;
}

/**
 * Thrown when a materialized node has missing or corrupt dependency metadata.
 */
class MissingDependencyMetadata extends Error {
    /**
     * @param {NodeIdentifier} nodeKey
     */
    constructor(nodeKey) {
        super(
            `Missing or corrupt dependency metadata for materialized node: ${nodeKey}`
        );
        this.name = "MissingDependencyMetadataError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {NodeIdentifier} nodeKey
 * @returns {MissingDependencyMetadata}
 */
function makeMissingDependencyMetadataError(nodeKey) {
    return new MissingDependencyMetadata(nodeKey);
}

/**
 * @param {unknown} object
 * @returns {object is MissingDependencyMetadata}
 */
function isMissingDependencyMetadata(object) {
    return object instanceof MissingDependencyMetadata;
}

/**
 * Thrown when create() is called on a node that already exists in the previous version.
 */
class CreateExistingNode extends Error {
    /**
     * @param {NodeIdentifier | NodeKeyString | NodeKey} nodeKey
     */
    constructor(nodeKey) {
        super(
            `Cannot create node ${nodeKey}: it already exists in the previous version. ` +
                `Use replace() to change its semantic value instead.`
        );
        this.name = "CreateExistingNodeError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {NodeIdentifier | NodeKeyString | NodeKey} nodeKey
 * @returns {CreateExistingNode}
 */
function makeCreateExistingNodeError(nodeKey) {
    return new CreateExistingNode(nodeKey);
}

/**
 * @param {unknown} object
 * @returns {object is CreateExistingNode}
 */
function isCreateExistingNode(object) {
    return object instanceof CreateExistingNode;
}

/**
 * Thrown when a migration decision cannot preserve the proof claimed by its API.
 */
class InvalidMigrationDecision extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "InvalidMigrationDecisionError";
    }
}

/**
 * @param {string} message
 * @returns {InvalidMigrationDecision}
 */
function makeInvalidMigrationDecisionError(message) {
    return new InvalidMigrationDecision(message);
}

/**
 * @param {unknown} object
 * @returns {object is InvalidMigrationDecision}
 */
function isInvalidMigrationDecision(object) {
    return object instanceof InvalidMigrationDecision;
}

/**
 * Thrown when a migration source replica persists an identifier outside the
 * supported `NodeIdentifier` domain.
 *
 * `docs/specs/incremental-graph-journal-types.md` §Persisted identifier form
 * across the bootstrap and migration boundary makes the domain a statement
 * about the persisted forms of every supported source era, and its fail-closed
 * consequence applies to this boundary as it does to the bootstrap boundary:
 * a replica persisting an identifier outside the domain is not a supported
 * source, so the migration rejects it instead of emitting a target replica that
 * materializes nodes no Journal record can name.
 *
 * The identifier is reported rather than corrected. Re-minting or normalizing it
 * would change which physical identity a materialized node has, which is a
 * persisted-data-format change and not a repair a single transition may perform.
 */
class UnsupportedPersistedIdentifier extends Error {
    /**
     * @param {string} context
     * @param {string} identifier
     */
    constructor(context, identifier) {
        super(
            `Unsupported persisted NodeIdentifier in ${context}: the replica persists ` +
            `${JSON.stringify(identifier)}, which is outside the supported NodeIdentifier domain. ` +
            "This replica is not a supported migration source, because a migration transports each " +
            "persisted identifier unchanged and the resulting target replica would materialize nodes " +
            "that no Journal record can name. The identifier is not re-minted or normalized, because " +
            "that would change which physical identity a materialized node has."
        );
        this.name = "UnsupportedPersistedIdentifierError";
        this.context = context;
        this.identifier = identifier;
    }
}

/**
 * @param {string} context
 * @param {string} identifier
 * @returns {UnsupportedPersistedIdentifier}
 */
function makeUnsupportedPersistedIdentifierError(context, identifier) {
    return new UnsupportedPersistedIdentifier(context, identifier);
}

/**
 * @param {unknown} object
 * @returns {object is UnsupportedPersistedIdentifier}
 */
function isUnsupportedPersistedIdentifierError(object) {
    return object instanceof UnsupportedPersistedIdentifier;
}

module.exports = {
    makeUnsupportedPersistedIdentifierError,
    isUnsupportedPersistedIdentifierError,
    makeDecisionConflictError,
    makeInvalidMigrationDecisionError,
    isInvalidMigrationDecision,
    isDecisionConflict,
    makeCreateExistingNodeError,
    isCreateExistingNode,
    makeUndecidedNodesError,
    isUndecidedNodes,
    makeSchemaCompatibilityError,
    isSchemaCompatibility,
    makeGetMissingNodeError,
    isGetMissingNode,
    makeMissingDependencyMetadataError,
    isMissingDependencyMetadata,
};
