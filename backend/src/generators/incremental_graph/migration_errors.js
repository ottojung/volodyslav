/**
 * Error classes for MigrationStorage operations.
 */

/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */

/**
 * Thrown when two different decisions are assigned to the same node.
 */
class DecisionConflict extends Error {
    /**
     * @param {NodeKeyString} nodeKey
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
 * @param {NodeKeyString} nodeKey
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
 * Thrown when override() is called twice with different values on the same node.
 */
class OverrideConflict extends Error {
    /**
     * @param {NodeKeyString} nodeKey
     */
    constructor(nodeKey) {
        super(
            `Override conflict for node ${nodeKey}: override() called with a different value`
        );
        this.name = "OverrideConflictError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {NodeKeyString} nodeKey
 * @returns {OverrideConflict}
 */
function makeOverrideConflictError(nodeKey) {
    return new OverrideConflict(nodeKey);
}

/**
 * @param {unknown} object
 * @returns {object is OverrideConflict}
 */
function isOverrideConflict(object) {
    return object instanceof OverrideConflict;
}

/**
 * Thrown when some nodes in S have no decision after the migration callback.
 */
class UndecidedNodes extends Error {
    /**
     * @param {NodeKeyString[]} undecidedNodes
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
 * @param {NodeKeyString[]} undecidedNodes
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
 * Thrown when DELETE propagation reaches a fan-in node whose non-deleted inputs remain.
 */
class PartialDeleteFanIn extends Error {
    /**
     * @param {NodeKeyString} nodeKey
     * @param {readonly NodeKeyString[]} inputs
     */
    constructor(nodeKey, inputs) {
        super(
            `Partial delete fan-in for node ${nodeKey}: cannot delete because not all inputs are deleted. ` +
                `Inputs: ${inputs.join(", ")}`
        );
        this.name = "PartialDeleteFanInError";
        this.nodeKey = nodeKey;
        this.inputs = inputs;
    }
}

/**
 * @param {NodeKeyString} nodeKey
 * @param {readonly NodeKeyString[]} inputs
 * @returns {PartialDeleteFanIn}
 */
function makePartialDeleteFanInError(nodeKey, inputs) {
    return new PartialDeleteFanIn(nodeKey, inputs);
}

/**
 * @param {unknown} object
 * @returns {object is PartialDeleteFanIn}
 */
function isPartialDeleteFanIn(object) {
    return object instanceof PartialDeleteFanIn;
}

/**
 * Thrown when keep/override/invalidate is called on a node incompatible with the new schema.
 */
class SchemaCompatibility extends Error {
    /**
     * @param {NodeKeyString} nodeKey
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
 * @param {NodeKeyString} nodeKey
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
     * @param {NodeKeyString} nodeKey
     */
    constructor(nodeKey) {
        super(`Node not found in previous version: ${nodeKey}`);
        this.name = "GetMissingNodeError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {NodeKeyString} nodeKey
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
 * Thrown when get() is called on a materialized node that has no computed value.
 */
class GetMissingValue extends Error {
    /**
     * @param {NodeKeyString} nodeKey
     */
    constructor(nodeKey) {
        super(
            `Node ${nodeKey} is in the previous version but has no computed value`
        );
        this.name = "GetMissingValueError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {NodeKeyString} nodeKey
 * @returns {GetMissingValue}
 */
function makeGetMissingValueError(nodeKey) {
    return new GetMissingValue(nodeKey);
}

/**
 * @param {unknown} object
 * @returns {object is GetMissingValue}
 */
function isGetMissingValue(object) {
    return object instanceof GetMissingValue;
}

/**
 * Thrown when a materialized node has missing or corrupt dependency metadata.
 */
class MissingDependencyMetadata extends Error {
    /**
     * @param {NodeKeyString} nodeKey
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
 * @param {NodeKeyString} nodeKey
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
     * @param {NodeKeyString} nodeKey
     */
    constructor(nodeKey) {
        super(
            `Cannot create node ${nodeKey}: it already exists in the previous version. ` +
                `Use override() to change its value instead.`
        );
        this.name = "CreateExistingNodeError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {NodeKeyString} nodeKey
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

module.exports = {
    makeDecisionConflictError,
    isDecisionConflict,
    makeOverrideConflictError,
    isOverrideConflict,
    makeCreateExistingNodeError,
    isCreateExistingNode,
    makeUndecidedNodesError,
    isUndecidedNodes,
    makePartialDeleteFanInError,
    isPartialDeleteFanIn,
    makeSchemaCompatibilityError,
    isSchemaCompatibility,
    makeGetMissingNodeError,
    isGetMissingNode,
    makeGetMissingValueError,
    isGetMissingValue,
    makeMissingDependencyMetadataError,
    isMissingDependencyMetadata,
};
