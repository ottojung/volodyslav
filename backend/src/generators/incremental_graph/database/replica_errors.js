/**
 * Error classes for the RootDatabase module.
 *
 * Dedicated error classes allow callers to distinguish replica-management
 * failures from generic errors without importing the full RootDatabase module.
 */

/**
 * Thrown when `_meta/current_replica` contains an unexpected value,
 * or when an API receives an invalid replica name argument.
 */
class InvalidReplicaPointerError extends Error {
    /**
     * @param {unknown} value - The invalid value that was read or passed.
     */
    constructor(value) {
        super(`Invalid replica name: "${String(value)}". Expected "x" or "y".`);
        this.name = 'InvalidReplicaPointerError';
        this.value = value;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidReplicaPointerError}
 */
function isInvalidReplicaPointerError(object) {
    return object instanceof InvalidReplicaPointerError;
}

/**
 * Thrown when the replica pointer write fails during `switchToReplica`.
 */
class SwitchReplicaError extends Error {
    /**
     * @param {string} name - The replica name we tried to switch to.
     * @param {unknown} cause - The underlying error.
     */
    constructor(name, cause) {
        super(`Failed to write replica pointer "${name}" to _meta/current_replica: ${String(cause)}`);
        this.name = 'SwitchReplicaError';
        this.replicaName = name;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SwitchReplicaError}
 */
function isSwitchReplicaError(object) {
    return object instanceof SwitchReplicaError;
}

/**
 * Thrown by `buildSchemaStorage().batch()` when the existing global/version in
 * the replica does not match the expected application version.
 * This indicates a logic error in migration ordering or staging-namespace usage.
 */
class SchemaBatchVersionError extends Error {
    /**
     * @param {string} expected - The expected version.
     * @param {string} found - The version actually stored in the replica.
     */
    constructor(expected, found) {
        super(`Version mismatch in batch operation: expected ${expected}, found ${found}`);
        this.name = 'SchemaBatchVersionError';
        this.expected = expected;
        this.found = found;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SchemaBatchVersionError}
 */
function isSchemaBatchVersionError(object) {
    return object instanceof SchemaBatchVersionError;
}

class MalformedIdentifierLookupError extends Error {
    /**
     * @param {unknown} value
     */
    constructor(value) {
        super(`Malformed identifiers_keys_map record: expected an array, got ${Array.isArray(value) ? 'array' : typeof value}.`);
        this.name = 'MalformedIdentifierLookupError';
        this.value = value;
    }
}

class MissingIdentifierLookupError extends Error {
    /**
     * @param {string} context
     */
    constructor(context) {
        super(
            `Missing identifiers_keys_map record in ${context}. ` +
            `This identifier-native graph snapshot is incomplete and cannot be used.`
        );
        this.name = 'MissingIdentifierLookupError';
        this.context = context;
    }
}

/**
 * @param {unknown} object
 * @returns {object is MissingIdentifierLookupError}
 */
function isMissingIdentifierLookupError(object) {
    return object instanceof MissingIdentifierLookupError;
}

/**
 * @param {unknown} object
 * @returns {object is MalformedIdentifierLookupError}
 */
function isMalformedIdentifierLookupError(object) {
    return object instanceof MalformedIdentifierLookupError;
}

class IdentifierLookupConflictError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'IdentifierLookupConflictError';
    }
}

/**
 * @param {unknown} object
 * @returns {object is IdentifierLookupConflictError}
 */
function isIdentifierLookupConflictError(object) {
    return object instanceof IdentifierLookupConflictError;
}

class MissingInputIdentifierError extends Error {
    /**
     * @param {string} identifierString
     * @param {string} context
     */
    constructor(identifierString, context) {
        super(
            `Input identifier ${identifierString} is missing from the ${context} ` +
            `identifier lookup. This indicates a corrupt graph: a node depends on ` +
            `this identifier, but it has no mapping to a semantic key.`
        );
        this.name = 'MissingInputIdentifierError';
        this.identifierString = identifierString;
        this.context = context;
    }
}

/**
 * @param {unknown} object
 * @returns {object is MissingInputIdentifierError}
 */
function isMissingInputIdentifierError(object) {
    return object instanceof MissingInputIdentifierError;
}

module.exports = {
    InvalidReplicaPointerError,
    isInvalidReplicaPointerError,
    SwitchReplicaError,
    isSwitchReplicaError,
    SchemaBatchVersionError,
    isSchemaBatchVersionError,
    MalformedIdentifierLookupError,
    isMalformedIdentifierLookupError,
    MissingIdentifierLookupError,
    isMissingIdentifierLookupError,
    IdentifierLookupConflictError,
    isIdentifierLookupConflictError,
    MissingInputIdentifierError,
    isMissingInputIdentifierError,
};
