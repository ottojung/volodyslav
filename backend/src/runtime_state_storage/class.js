const structure = require("./structure");

/** @typedef {import('./types').RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */
/** @typedef {import('./types').RuntimeState} RuntimeState */
/** @typedef {import('../filesystem/file').ExistingFile} ExistingFile */

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
     * Path to the state.json file, set during transaction
     * @type {ExistingFile|null|undefined}
     */
    stateFile = undefined;

    /**
     * Cache for existing state loaded from state.json
     * @private
     * @type {RuntimeState|null}
     */
    existingStateCache = null;

    /**
     * Capabilities object for file operations.
     * @type {RuntimeStateStorageCapabilities}
     */
    capabilities;

    /**
     * @constructor
     * Initializes runtime state storage.
     * @param {RuntimeStateStorageCapabilities} capabilities - The capabilities object for file operations.
     */
    constructor(capabilities) {
        this.capabilities = capabilities;
    }

    /**
     * Sets a new runtime state to be written to state.json
     * @param {RuntimeState} state - The runtime state object to write
     */
    setState(state) {
        this.newState = state;
    }

    /**
     * Gets the new runtime state to be written
     * @returns {RuntimeState|null} - The runtime state object or null if none set
     */
    getNewState() {
        return this.newState;
    }

    /**
     * Lazily reads and returns the runtime state that existed in state.json
     * at the start of the current transaction. The file is only read
     * on the first call, subsequent calls return cached results.
     *
     * Uses capabilities: reader, logger
     *
     * @returns {Promise<RuntimeState|null>} - The existing runtime state or null if not found/invalid
     * @throws {Error} - If called outside of a transaction.
     */
    async getExistingState() {
        if (this.stateFile === undefined) {
            throw new Error(
                "getExistingState() called outside of a transaction"
            );
        }

        // Return cached results if available
        if (this.existingStateCache !== null) {
            return this.existingStateCache;
        }

        // If state file doesn't exist, return null
        if (this.stateFile === null) {
            this.existingStateCache = null;
            return null;
        }

        try {
            const fileContent = await this.capabilities.reader.readFileAsText(this.stateFile.path);
            const obj = JSON.parse(fileContent);

            const result = structure.tryDeserialize(obj);

            // If deserialization returned an error object, it means the state is invalid
            if (structure.isTryDeserializeError(result)) {
                this.capabilities.logger.logWarning(
                    {
                        filepath: this.stateFile.path,
                        error: result.message,
                        field: result.field,
                        value: result.value,
                        expectedType: result.expectedType,
                        errorType: result.name
                    },
                    "Found invalid runtime state object in file"
                );
                this.existingStateCache = null;
                return null;
            }

            this.existingStateCache = result;
            return this.existingStateCache;
        } catch (error) {
            this.capabilities.logger.logWarning(
                {
                    filepath: this.stateFile.path,
                    error: error instanceof Error ? error.message : String(error)
                },
                "Failed to read runtime state file"
            );
            this.existingStateCache = null;
            return null;
        }
    }

    /**
     * Gets the current runtime state, either from what's been set in this transaction
     * or from the existing state file. If neither exists, creates a default state.
     *
     * @returns {Promise<RuntimeState>} - The current runtime state
     */
    async getCurrentState() {
        if (this.newState !== null) {
            return this.newState;
        }

        const existing = await this.getExistingState();
        if (existing !== null) {
            return existing;
        }

        // Create default state if none exists
        return structure.makeDefault(this.capabilities.datetime);
    }
}

/** @typedef {RuntimeStateStorageClass} RuntimeStateStorage */

/**
 * Creates a new RuntimeStateStorage instance.
 * @param {RuntimeStateStorageCapabilities} capabilities
 * @returns {RuntimeStateStorage}
 */
function make(capabilities) {
    return new RuntimeStateStorageClass(capabilities);
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
