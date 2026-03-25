const structure = require("./structure");

/** @typedef {import('./types').RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */
/** @typedef {import('./types').RuntimeState} RuntimeState */

/**
 * A class to manage runtime state storage.
 */
class RuntimeStateStorageClass {
    /**
     * New runtime state to be written.
     * @private
     * @type {RuntimeState|null}
     */
    newState = null;

    /**
     * Cache for existing state loaded from the DB at the start of the transaction.
     * @private
     * @type {RuntimeState|null}
     */
    existingStateCache = null;

    /**
     * Whether we've attempted to deserialize the existing state.
     * @private
     * @type {boolean}
     */
    existingStateCacheLoaded = false;

    /**
     * Raw object read from the DB at the start of the transaction, or null if absent.
     * @private
     * @type {Record<string, unknown>|null}
     */
    existingStateData;

    /**
     * Capabilities object.
     * @private
     * @type {RuntimeStateStorageCapabilities}
     */
    capabilities;

    /**
     * @constructor
     * Initializes runtime state storage.
     * @param {RuntimeStateStorageCapabilities} capabilities - The capabilities object.
     * @param {Record<string, unknown>|null} existingStateData - The raw state object from the DB, or null if absent.
     */
    constructor(capabilities, existingStateData) {
        this.capabilities = capabilities;
        this.existingStateData = existingStateData;
    }

    /**
     * Sets a new runtime state to be written to the DB.
     * @param {RuntimeState} state - The runtime state object to write
     */
    setState(state) {
        this.newState = state;
    }

    /**
     * Gets the new runtime state to be written.
     * @returns {RuntimeState|null} - The runtime state object or null if none set
     */
    getNewState() {
        return this.newState;
    }

    /**
     * Lazily deserializes and returns the runtime state that existed in the DB
     * at the start of the current transaction. The deserialization is only done
     * on the first call; subsequent calls return cached results.
     *
     * @returns {Promise<RuntimeState|null>} - The existing runtime state or null if not found
     * @throws {structure.RuntimeStateCorruptedError} - If the stored state structure is invalid
     */
    async getExistingState() {
        if (this.existingStateCacheLoaded) {
            return this.existingStateCache;
        }

        if (this.existingStateData === null) {
            this.existingStateCache = null;
            this.existingStateCacheLoaded = true;
            return null;
        }

        const result = structure.tryDeserialize(this.existingStateData);

        if (structure.isTryDeserializeError(result)) {
            throw new structure.RuntimeStateCorruptedError(result, "db:runtime_state/current");
        }

        for (const err of result.taskErrors) {
            this.capabilities.logger.logWarning(
                {
                    index: err.taskIndex,
                    error: err.message,
                    field: err.field,
                    value: err.value,
                    expectedType: err.expectedType,
                    errorType: err.name,
                },
                "SkippedInvalidTask",
            );
        }
        if (result.migrated) {
            this.capabilities.logger.logInfo(
                { fromVersion: 1, toVersion: structure.RUNTIME_STATE_VERSION },
                "RuntimeStateMigrated",
            );
        }

        this.existingStateCache = result.state;
        this.existingStateCacheLoaded = true;
        return this.existingStateCache;
    }

    /**
     * Gets the current runtime state, either from what's been set in this transaction
     * or from the existing DB state. If neither exists, creates a default state.
     *
     * @returns {Promise<RuntimeState>} - The current runtime state
     * @throws {structure.RuntimeStateCorruptedError} - If the stored state structure is invalid
     */
    async getCurrentState() {
        if (this.newState !== null) {
            return this.newState;
        }

        const existing = await this.getExistingState();
        if (existing !== null) {
            return existing;
        }

        return structure.makeDefault(this.capabilities.datetime);
    }
}

/** @typedef {RuntimeStateStorageClass} RuntimeStateStorage */

/**
 * Creates a new RuntimeStateStorage instance.
 * @param {RuntimeStateStorageCapabilities} capabilities
 * @param {Record<string, unknown>|null} existingStateData - The raw state object from the DB, or null if absent.
 * @returns {RuntimeStateStorage}
 */
function make(capabilities, existingStateData) {
    return new RuntimeStateStorageClass(capabilities, existingStateData);
}

/**
 * Type guard for RuntimeStateStorage.
 * @param {unknown} object
 * @returns {object is RuntimeStateStorage}
 */
function isRuntimeStateStorage(object) {
    return object instanceof RuntimeStateStorageClass;
}

module.exports = {
    make,
    isRuntimeStateStorage,
};
