/**
 * Implements atomic, Git-based storage for runtime state.
 *
 * Call `transaction(transformation)` with a function that uses
 * `storage.setState(state)` to queue runtime state changes. The
 * process writes the state to `state.json` and commits the changes.
 * If any step fails, the error is rethrown.
 */

const gitstore = require("../gitstore");
const structure = require("./structure");
const { make: makeRuntimeStateStorage } = require("./class");

/** @typedef {import("../filesystem/file").ExistingFile} ExistingFile */
/** @typedef {import("./types").RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */
/** @typedef {import("./class").RuntimeStateStorage} RuntimeStateStorage */
/** @typedef {import("./types").RuntimeState} RuntimeState */

/**
 * @template T
 * @typedef {(runtimeStateStorage: RuntimeStateStorage) => Promise<T>} Transformation
 */

/**
 * This function performs a transaction on the runtime state storage.
 * It uses the gitstore system with "empty" initial state for local-only operation.
 *
 * @template T
 * @param {RuntimeStateStorageCapabilities} capabilities - An object containing the capabilities.
 * @param {Transformation<T>} transformation - Async callback to apply to the storage.
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    return await gitstore.transaction(
        capabilities,
        "runtime-state-repository",
        "empty",
        async (store) => {
            const workTree = await store.getWorkTree();

            // Set up the state file path
            const statePath = require("path").join(workTree, "state.json");
            const existingStateFile = await capabilities.checker
                .instantiate(statePath)
                .catch(() => null);

            const stateFile = existingStateFile || await capabilities.creator.createFile(statePath);
            const runtimeStateStorage = makeRuntimeStateStorage(capabilities, stateFile);

            // Run the transformation
            const result = await transformation(runtimeStateStorage);

            // Handle state changes
            const newState = runtimeStateStorage.getNewState();
            if (newState !== null) {
                const serialized = structure.serialize(newState);
                const stateString = JSON.stringify(serialized, null, '\t');

                // Check if content has actually changed before writing and committing
                let hasChanges = true;
                if (existingStateFile !== null) {
                    try {
                        const existingContent = await capabilities.reader.readFileAsText(existingStateFile.path);
                        hasChanges = existingContent !== stateString;
                    } catch (error) {
                        // If we can't read the existing file, assume there are changes
                        hasChanges = true;
                    }
                }

                if (hasChanges) {
                    // Write atomically to the state file
                    await capabilities.writer.writeFile(stateFile, stateString);

                    // Commit the changes
                    await store.commit("Runtime state update");
                }
            }

            return result;
        }
    );
}

module.exports = { transaction };
