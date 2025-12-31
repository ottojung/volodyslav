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

/**
 * Error for invalid schema definitions.
 */
class InvalidSchema extends Error {
    /**
     * @param {string} message
     * @param {string} schemaOutput
     */
    constructor(message, schemaOutput) {
        super(`Invalid schema '${schemaOutput}': ${message}`);
        this.name = "InvalidSchema";
        this.schemaOutput = schemaOutput;
    }
}

/**
 * Constructs an InvalidSchema error.
 * @param {string} message
 * @param {string} schemaOutput
 * @returns {InvalidSchema}
 */
function makeInvalidSchemaError(message, schemaOutput) {
    return new InvalidSchema(message, schemaOutput);
}

/**
 * Type guard for InvalidSchema.
 * @param {unknown} object
 * @returns {object is InvalidSchema}
 */
function isInvalidSchema(object) {
    return object instanceof InvalidSchema;
}

/**
 * Error for attempting to operate on a schema pattern directly.
 */
class SchemaPatternNotAllowed extends Error {
    /**
     * @param {string} pattern
     */
    constructor(pattern) {
        super(
            `Cannot operate directly on schema pattern '${pattern}'. ` +
                `Schema patterns with variables can only be used as templates. ` +
                `Provide concrete instantiations instead.`
        );
        this.name = "SchemaPatternNotAllowed";
        this.pattern = pattern;
    }
}

/**
 * Constructs a SchemaPatternNotAllowed error.
 * @param {string} pattern
 * @returns {SchemaPatternNotAllowed}
 */
function makeSchemaPatternNotAllowedError(pattern) {
    return new SchemaPatternNotAllowed(pattern);
}

/**
 * Type guard for SchemaPatternNotAllowed.
 * @param {unknown} object
 * @returns {object is SchemaPatternNotAllowed}
 */
function isSchemaPatternNotAllowed(object) {
    return object instanceof SchemaPatternNotAllowed;
}

module.exports = {
    makeInvalidNodeError,
    isInvalidNode,
    makeInvalidSchemaError,
    isInvalidSchema,
    makeSchemaPatternNotAllowedError,
    isSchemaPatternNotAllowed,
};
