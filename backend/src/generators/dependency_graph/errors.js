/**
 * Base error class for database operations.
 */
class InvalidNode extends Error {
    /**
     * @param {string} nodeName
     */
    constructor(nodeName) {
        super(`Node ${nodeName} not found in the dependency graph.`);
        this.name = "InvalidNode";
        this.nodeName = nodeName;
    }
}

/**
 * Constructs an InvalidNode error.
 * @param {string} nodeName
 * @returns {InvalidNode}
 */
function makeInvalidNodeError(nodeName) {
    return new InvalidNode(nodeName);
}

/**
 * Type guard for InvalidNode.
 * @param {unknown} object
 * @returns {object is InvalidNode}
 */
function isInvalidNode(object) {
    return object instanceof InvalidNode;
}

module.exports = {
    makeInvalidNodeError,
    isInvalidNode,
};
