/**
 * Implements atomic, Git-based storage for runtime state.
 *
 * Call `transaction(transformation)` with a function that uses
 * `storage.setState(state)` to queue runtime state changes. The
 * process writes the state to `state.json` and commits the changes.
 * If any step fails, the error is rethrown.
 */

const path = require("path");
const { clone, push } = require("../gitstore/wrappers");
const structure = require("./structure");
const { make: makeRuntimeStateStorage } = require("./class");

/** @typedef {import("../filesystem/file").ExistingFile} ExistingFile */
/** @typedef {import("./types").RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */
/** @typedef {import("./class").RuntimeStateStorage} RuntimeStateStorage */
/** @typedef {import("./types").RuntimeState} RuntimeState */

/**
 * Writes a runtime state to a specified file.
 * @param {RuntimeStateStorageCapabilities} capabilities - The capabilities needed for writing
 * @param {string} filePath - The file path where the state will be written.
 * @param {RuntimeState} state - The runtime state object to write.
 * @returns {Promise<void>} - A promise that resolves when the state is written.
 */
async function writeStateToFile(capabilities, filePath, state) {
    const serialized = structure.serialize(state);
    const stateString = JSON.stringify(serialized, null, '\t');
    const file = await capabilities.creator.createFile(filePath);
    await capabilities.writer.writeFile(file, stateString);
}

/**
 * @template T
 * @typedef {(runtimeStateStorage: RuntimeStateStorage) => Promise<T>} Transformation
 */

/**
 * Performs a Git-backed transaction using the given storage and transformation.
 * @template T
 * @param {RuntimeStateStorageCapabilities} capabilities - An object containing the capabilities.
 * @param {RuntimeStateStorage} runtimeStateStorage - The runtime state storage instance.
 * @param {Transformation<T>} transformation - Async callback to apply to the storage.
 * @returns {Promise<T>}
 */
async function performGitTransaction(
    capabilities,
    runtimeStateStorage,
    transformation
) {
    // Use a custom transaction function for the local-only repository
    const workTree = await capabilities.creator.createTemporaryDirectory(capabilities);
    
    try {
        // Ensure the local repository exists
        const { ensureAccessible } = require("./synchronize");
        const gitDir = await ensureAccessible(capabilities);
        
        // Clone the repository to a temporary work tree
        await clone(capabilities, gitDir, workTree);
        
        const statePath = path.join(workTree, "state.json");
        const stateFile = await capabilities.checker
            .instantiate(statePath)
            .catch(() => null);

        // Set file path for possible lazy loading
        runtimeStateStorage.stateFile = stateFile;

        // Run user-provided transformation to set state
        const result = await transformation(runtimeStateStorage);

        // Get queued state update
        const newState = runtimeStateStorage.getNewState();

        // Track if we need to commit
        let needsCommit = false;

        // Write state if changed
        if (newState !== null) {
            await writeStateToFile(capabilities, statePath, newState);
            needsCommit = true;
        }

        // Commit changes if needed
        if (needsCommit) {
            const { commit } = require("../gitstore/wrappers");
            await commit(capabilities, path.join(workTree, ".git"), workTree, "Runtime state update");
            
            // Push changes back to the local repository
            await push(capabilities, workTree);
        }

        return result;
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
}

/**
 * Applies a transformation within a Git-backed runtime state transaction.
 * @template T
 * @param {RuntimeStateStorageCapabilities} capabilities - An object containing the capabilities.
 * @param {Transformation<T>} transformation - The transformation to execute.
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    const runtimeStateStorage = makeRuntimeStateStorage(capabilities);
    return await performGitTransaction(
        capabilities,
        runtimeStateStorage,
        transformation
    );
}

module.exports = { transaction };
