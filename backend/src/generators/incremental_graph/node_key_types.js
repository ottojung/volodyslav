/**
 * Nominal type wrappers for node key strings and node names.
 *
 * These helpers live outside the `database/` subfolder so they can be imported
 * by `node_key.js` without creating a circular dependency through
 * `database/index.js`.
 *
 * `NodeKeyString` and `NodeName` are nominal string types — at runtime they are
 * plain strings; the classes exist only to give TypeScript/JSDoc distinct brands.
 */

class NodeKeyStringClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand;
    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("NodeKeyString cannot be instantiated");
        }
    }
}

/**
 * @param {string} _value
 * @returns {_value is NodeKeyString}
 */
function castToNodeKeyString(_value) {
    return true;
}

/**
 * @param {string} nodeKeyStr
 * @returns {NodeKeyString}
 */
function stringToNodeKeyString(nodeKeyStr) {
    if (castToNodeKeyString(nodeKeyStr)) {
        return nodeKeyStr;
    }
    throw new Error("Invalid node key string");
}

/**
 * @param {NodeKeyString} nodeKeyString
 * @returns {string}
 */
function nodeKeyStringToString(nodeKeyString) {
    if (typeof nodeKeyString === "string") {
        return nodeKeyString;
    }
    throw new Error("Invalid node key string type");
}

/**
 * A serialized node key string for storage.
 * @typedef {NodeKeyStringClass} NodeKeyString
 */

class NodeNameClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand;
    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("NodeName cannot be instantiated");
        }
    }
}

/**
 * @param {string} _value
 * @returns {_value is NodeName}
 */
function castToNodeName(_value) {
    return true;
}

/**
 * @param {string} nodeNameStr
 * @returns {NodeName}
 */
function stringToNodeName(nodeNameStr) {
    if (castToNodeName(nodeNameStr)) {
        return nodeNameStr;
    }
    throw new Error("Invalid node name string");
}

/**
 * @param {NodeName} nodeName
 * @returns {string}
 */
function nodeNameToString(nodeName) {
    if (typeof nodeName === "string") {
        return nodeName;
    }
    throw new Error("Invalid node name type");
}

/**
 * The head/functor part of SchemaPattern.
 * @typedef {NodeNameClass} NodeName
 */

module.exports = {
    NodeKeyStringClass,
    NodeNameClass,
    stringToNodeKeyString,
    nodeKeyStringToString,
    stringToNodeName,
    nodeNameToString,
};
