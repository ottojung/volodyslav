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
 * Thrown by `buildSchemaStorage().batch()` when the existing meta/version in
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

module.exports = {
    InvalidReplicaPointerError,
    isInvalidReplicaPointerError,
    SwitchReplicaError,
    isSwitchReplicaError,
    SchemaBatchVersionError,
    isSchemaBatchVersionError,
};
