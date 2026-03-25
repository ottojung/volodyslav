/**
 * Implements atomic, DB-backed storage for runtime state.
 *
 * Call `transaction(transformation)` with a function that uses
 * `storage.setState(state)` to queue runtime state changes. The
 * process writes the state to the temporary LevelDB database.
 * If any step fails, the error is rethrown.
 */

const structure = require("./structure");
const { make: makeRuntimeStateStorage } = require("./class");

/** @typedef {import("./types").RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */
/** @typedef {import("./class").RuntimeStateStorage} RuntimeStateStorage */
/** @typedef {import("./types").RuntimeState} RuntimeState */

/**
 * @template T
 * @typedef {(runtimeStateStorage: RuntimeStateStorage) => Promise<T>} Transformation
 */

/**
 * Perform a transaction on the runtime state storage.
 * Reads the current state from the temporary DB, runs the transformation callback,
 * and persists any state changes back to the DB.
 *
 * @template T
 * @param {RuntimeStateStorageCapabilities} capabilities - An object containing the capabilities.
 * @param {Transformation<T>} transformation - Async callback to apply to the storage.
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    // Read current state from DB
    const rawData = await capabilities.temporary.getRuntimeState();
    const runtimeStateStorage = makeRuntimeStateStorage(capabilities, rawData);

    // Run the transformation
    const result = await transformation(runtimeStateStorage);

    // Persist state if it was changed
    const newState = runtimeStateStorage.getNewState();
    if (newState !== null) {
        const serialized = structure.serialize(newState);
        await capabilities.temporary.setRuntimeState(serialized);
    }

    return result;
}

module.exports = { transaction };
