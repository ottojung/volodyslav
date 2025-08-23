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
     * @private
     * @type {ExistingFile}
     */
    stateFile;

    /**
     * Cache for existing state loaded from state.json
     * @private
     * @type {RuntimeState|null}
     */
    existingStateCache = null;

    /**
     * Whether we've attempted to load the existing state cache
     * @private
     * @type {boolean}
     */
    existingStateCacheLoaded = false;

    /**
     * Cache for the raw contents of the state.json file as text
     * @private
     * @type {string|null}
     */
    existingFileContent = null;

    /**
     * Capabilities object for file operations.
     * @private
     * @type {RuntimeStateStorageCapabilities}
     */
    capabilities;

    /**
     * @constructor
     * Initializes runtime state storage.
     * @param {RuntimeStateStorageCapabilities} capabilities - The capabilities object for file operations.
     * @param {ExistingFile} stateFile - The state file object for the transaction.
     */
    constructor(capabilities, stateFile) {
        this.capabilities = capabilities;
        this.stateFile = stateFile;
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
     * @returns {Promise<RuntimeState|null>} - The existing runtime state or null if file not found
     * @throws {structure.RuntimeStateFileParseError} - If the state file cannot be parsed as JSON
     * @throws {structure.RuntimeStateCorruptedError} - If the state file structure is invalid
     * @throws {Error} - If called outside of a transaction.
     */
    async getExistingState() {
        // Return cached results if available
        if (this.existingStateCacheLoaded) {
            return this.existingStateCache;
        }

        try {
            const fileContent = await this.getFileContent();
            
            // Handle empty file as if it doesn't exist
            if (!fileContent.trim()) {
                this.existingStateCache = null;
                this.existingStateCacheLoaded = true;
                return null;
            }
            
            let obj;
            try {
                obj = JSON.parse(fileContent);
            } catch (parseError) {
                // File exists but contains invalid JSON - this is corruption
                throw new structure.RuntimeStateFileParseError(
                    `Failed to parse runtime state file as JSON: ${parseError.message}`,
                    this.stateFile.path,
                    parseError
                );
            }

            const result = structure.tryDeserialize(obj);

            if (structure.isTryDeserializeError(result)) {
                // File exists but structure is invalid - this is corruption
                throw new structure.RuntimeStateCorruptedError(result, this.stateFile.path);
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
        } catch (error) {
            if (structure.isRuntimeStateCorruptedError(error) || structure.isRuntimeStateFileParseError(error)) {
                // Re-throw corruption/parsing errors as-is
                throw error;
            }

            // Handle file not found and other I/O errors - these are not corruption
            // File not existing is a normal case, not an error
            this.existingStateCache = null;
            this.existingStateCacheLoaded = true;
            return null;
        }
    }

    /**
     * Gets the current runtime state, either from what's been set in this transaction
     * or from the existing state file. If neither exists, creates a default state.
     *
     * @returns {Promise<RuntimeState>} - The current runtime state
     * @throws {structure.RuntimeStateFileParseError} - If the state file cannot be parsed as JSON
     * @throws {structure.RuntimeStateCorruptedError} - If the state file structure is invalid
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

    /**
     * @returns {Promise<string>}
     */
    async getFileContent() {
        if (this.existingFileContent) {
            return this.existingFileContent;
        }

        const fileContent = await this.capabilities.reader.readFileAsText(this.stateFile.path);
        this.existingFileContent = fileContent;
        return fileContent;
    }
}

/** @typedef {RuntimeStateStorageClass} RuntimeStateStorage */

/**
 * Creates a new RuntimeStateStorage instance.
 * @param {RuntimeStateStorageCapabilities} capabilities
 * @param {ExistingFile} stateFile - The state file object for the transaction.
 * @returns {RuntimeStateStorage}
 */
function make(capabilities, stateFile) {
    return new RuntimeStateStorageClass(capabilities, stateFile);
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
