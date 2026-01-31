
/** @typedef {import('./database/types').NodeName} NodeName */
/** @typedef {import('./database/types').SchemaPattern} SchemaPattern */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */

/**
 * Base error class for database operations.
 */
class InvalidNode extends Error {
    /**
     * @param {NodeName} nodeName
     */
    constructor(nodeName) {
        super(`Node ${nodeName} not found in the incremental graph.`);
        this.name = "InvalidNodeError";
        this.nodeName = nodeName;
    }
}

/**
 * Constructs an InvalidNode error.
 * @param {NodeName} nodeName
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
 * Error for invalid node name values.
 */
class InvalidNodeName extends Error {
    /**
     * @param {string} nodeName
     */
    constructor(nodeName) {
        super(`Invalid node name ${JSON.stringify(nodeName)}. Node names must be valid identifiers.`);
        this.name = "InvalidNodeNameError";
        this.nodeName = nodeName;
    }
}

/**
 * Constructs an InvalidNodeName error.
 * @param {string} nodeName
 * @returns {InvalidNodeName}
 */
function makeInvalidNodeNameError(nodeName) {
    return new InvalidNodeName(nodeName);
}

/**
 * Type guard for InvalidNodeName.
 * @param {unknown} object
 * @returns {object is InvalidNodeName}
 */
function isInvalidNodeName(object) {
    return object instanceof InvalidNodeName;
}

/**
 * Error for invalid schema definitions.
 */
class InvalidSchema extends Error {
    /**
     * @param {string} message
     * @param {string} schemaPattern
     */
    constructor(message, schemaPattern) {
        const qSchemaPattern = JSON.stringify(schemaPattern);
        super(`Invalid schema ${qSchemaPattern}: ${message}`);
        this.name = "InvalidSchemaError";
        this.schemaPattern = schemaPattern;
    }
}

/**
 * Constructs an InvalidSchema error.
 * @param {string} message
 * @param {string} schemaPattern
 * @returns {InvalidSchema}
 */
function makeInvalidSchemaError(message, schemaPattern) {
    return new InvalidSchema(message, schemaPattern);
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
        this.name = "SchemaPatternNotAllowedError";
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

/**
 * Error for arity mismatch in bindings.
 */
class ArityMismatch extends Error {
    /**
     * @param {NodeName} nodeName - The node name (functor/head)
     * @param {number} expected
     * @param {number} received
     */
    constructor(nodeName, expected, received) {
        super(
            `Arity mismatch: nodeName '${nodeName}' expects ${expected} arguments but received ${received} bindings`
        );
        this.name = "ArityMismatchError";
        this.nodeName = nodeName;
        this.expectedArity = expected;
        this.actualArity = received;
    }
}

/**
 * Constructs an ArityMismatch error.
 * @param {NodeName} nodeName - The node name (functor/head)
 * @param {number} expected
 * @param {number} received
 * @returns {ArityMismatch}
 */
function makeArityMismatchError(nodeName, expected, received) {
    return new ArityMismatch(nodeName, expected, received);
}

/**
 * Type guard for ArityMismatch.
 * @param {unknown} object
 * @returns {object is ArityMismatch}
 */
function isArityMismatch(object) {
    return object instanceof ArityMismatch;
}

/**
 * Error for invalid expression syntax (parse failures).
 */
class InvalidExpression extends Error {
    /**
     * @param {string} expression
     * @param {string} reason
     */
    constructor(expression, reason) {
        const qExpression = JSON.stringify(expression);
        super(`Invalid expression ${qExpression}: ${reason}`);
        this.name = "InvalidExpressionError";
        this.expression = expression;
    }
}

/**
 * Constructs an InvalidExpression error.
 * @param {string} expression
 * @param {string} reason
 * @returns {InvalidExpression}
 */
function makeInvalidExpressionError(expression, reason) {
    return new InvalidExpression(expression, reason);
}

/**
 * Type guard for InvalidExpression.
 * @param {unknown} object
 * @returns {object is InvalidExpression}
 */
function isInvalidExpression(object) {
    return object instanceof InvalidExpression;
}

/**
 * Error for schema cycle detection.
 */
class SchemaCycle extends Error {
    /**
     * @param {Array<SchemaPattern>} cycle
     */
    constructor(cycle) {
        super(`Schema cycle detected: ${cycle.join(" -> ")}`);
        this.name = "SchemaCycleError";
        this.cycle = cycle;
    }
}

/**
 * Constructs a SchemaCycle error.
 * @param {Array<SchemaPattern>} cycle
 * @returns {SchemaCycle}
 */
function makeSchemaCycleError(cycle) {
    return new SchemaCycle(cycle);
}

/**
 * Type guard for SchemaCycle.
 * @param {unknown} object
 * @returns {object is SchemaCycle}
 */
function isSchemaCycle(object) {
    return object instanceof SchemaCycle;
}

/**
 * Error for missing value when node is marked up-to-date.
 */
class MissingValue extends Error {
    /**
     * @param {NodeKeyString} nodeKey
     */
    constructor(nodeKey) {
        super(
            `Expected value for up-to-date node '${nodeKey}', but found none. ` +
                `This indicates database corruption or an implementation bug.`
        );
        this.name = "MissingValueError";
        this.nodeKey = nodeKey;
    }
}

/**
 * Constructs a MissingValue error.
 * @param {NodeKeyString} nodeKey
 * @returns {MissingValue}
 */
function makeMissingValueError(nodeKey) {
    return new MissingValue(nodeKey);
}

/**
 * Type guard for MissingValue.
 * @param {unknown} object
 * @returns {object is MissingValue}
 */
function isMissingValue(object) {
    return object instanceof MissingValue;
}

/**
 * Error for overlapping schema patterns.
 */
class SchemaOverlap extends Error {
    /**
     * @param {Array<SchemaPattern>} patterns
     */
    constructor(patterns) {
        super(
            `Schema patterns overlap: ${patterns.join(", ")}. ` +
                `All schema output patterns must be mutually exclusive.`
        );
        this.name = "SchemaOverlapError";
        this.patterns = patterns;
    }
}

/**
 * Constructs a SchemaOverlap error.
 * @param {Array<SchemaPattern>} patterns
 * @returns {SchemaOverlap}
 */
function makeSchemaOverlapError(patterns) {
    return new SchemaOverlap(patterns);
}

/**
 * Type guard for SchemaOverlap.
 * @param {unknown} object
 * @returns {object is SchemaOverlap}
 */
function isSchemaOverlap(object) {
    return object instanceof SchemaOverlap;
}

/**
 * Error for invalid computor return value.
 */
class InvalidComputorReturnValue extends Error {
    /**
     * @param {NodeName} nodeName
     * @param {unknown} value
     */
    constructor(nodeName, value) {
        super(
            `Computor for node '${nodeName}' returned an invalid value: ${value}. ` +
                `Computors must return a valid ComputedValue or Unchanged, not null or undefined.`
        );
        this.name = "InvalidComputorReturnValueError";
        this.nodeName = nodeName;
        this.value = value;
    }
}

/**
 * Constructs an InvalidComputorReturnValue error.
 * @param {NodeName} nodeName
 * @param {unknown} value
 * @returns {InvalidComputorReturnValue}
 */
function makeInvalidComputorReturnValueError(nodeName, value) {
    return new InvalidComputorReturnValue(nodeName, value);
}

/**
 * Type guard for InvalidComputorReturnValue.
 * @param {unknown} object
 * @returns {object is InvalidComputorReturnValue}
 */
function isInvalidComputorReturnValue(object) {
    return object instanceof InvalidComputorReturnValue;
}

/**
 * Error for returning Unchanged without a previous value.
 */
class InvalidUnchanged extends Error {
    /**
     * @param {NodeKeyString} nodeKey
     */
    constructor(nodeKey) {
        super(
            `Computor returned Unchanged for node '${nodeKey}' without an existing value. ` +
                `Unchanged is only valid when an old value is present.`
        );
        this.name = "InvalidUnchangedError";
        this.nodeKey = nodeKey;
    }
}

/**
 * Constructs an InvalidUnchanged error.
 * @param {NodeKeyString} nodeKey
 * @returns {InvalidUnchanged}
 */
function makeInvalidUnchangedError(nodeKey) {
    return new InvalidUnchanged(nodeKey);
}

/**
 * Type guard for InvalidUnchanged.
 * @param {unknown} object
 * @returns {object is InvalidUnchanged}
 */
function isInvalidUnchanged(object) {
    return object instanceof InvalidUnchanged;
}

/**
 * Error for schema arity conflict (same head with different arities).
 */
class SchemaArityConflict extends Error {
    /**
     * @param {NodeName} nodeName
     * @param {number[]} arities
     */
    constructor(nodeName, arities) {
        super(
            `Schema arity conflict: head '${nodeName}' appears with multiple arities [${arities.join(", ")}]. ` +
                `Each head must have a single arity across all schema outputs.`
        );
        this.name = "SchemaArityConflictError";
        this.nodeName = nodeName;
        this.arities = arities;
    }
}

/**
 * Constructs a SchemaArityConflict error.
 * @param {NodeName} nodeName
 * @param {number[]} arities
 * @returns {SchemaArityConflict}
 */
function makeSchemaArityConflictError(nodeName, arities) {
    return new SchemaArityConflict(nodeName, arities);
}

/**
 * Type guard for SchemaArityConflict.
 * @param {unknown} object
 * @returns {object is SchemaArityConflict}
 */
function isSchemaArityConflict(object) {
    return object instanceof SchemaArityConflict;
}

module.exports = {
    makeInvalidNodeError,
    isInvalidNode,
    makeInvalidNodeNameError,
    isInvalidNodeName,
    makeInvalidSchemaError,
    isInvalidSchema,
    makeSchemaPatternNotAllowedError,
    isSchemaPatternNotAllowed,
    makeArityMismatchError,
    isArityMismatch,
    makeInvalidExpressionError,
    isInvalidExpression,
    makeSchemaCycleError,
    isSchemaCycle,
    makeMissingValueError,
    isMissingValue,
    makeSchemaOverlapError,
    isSchemaOverlap,
    makeInvalidComputorReturnValueError,
    isInvalidComputorReturnValue,
    makeInvalidUnchangedError,
    isInvalidUnchanged,
    makeSchemaArityConflictError,
    isSchemaArityConflict,
};
