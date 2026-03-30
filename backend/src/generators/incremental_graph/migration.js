
// This file contains the current migration callback.

const { stringToNodeName } = require("./database");
const { deserializeNodeKey } = require("./node_key");

/**
 * @typedef {import('../interface/types').GeneratorsCapabilities} GeneratorsCapabilities
 */

/**
 * @typedef {import('./migration_storage').MigrationStorage} MigrationStorage
 */

/**
 * A migration callback that keeps all nodes of a certain type.
 *
 * @param {string} nodeName - The name of the node type to keep (e.g., "meta_events")
 * @param {MigrationStorage} storage - The migration storage instance
 * @returns {Promise<void>}
 */
async function keepNodeType(nodeName, storage) {
    const nodeNameTyped = stringToNodeName(nodeName);
    const nodeKeys = storage.listMaterializedNodes();
    for await (const nodeKey of nodeKeys) {
        const parsed = deserializeNodeKey(nodeKey);
        if (parsed.head === nodeNameTyped) {
            await storage.keep(nodeKey);
        }
    }
}

/**
 * A migration callback that deletes all nodes of a certain type.
 *
 * @param {string} nodeName - The name of the node type to delete (e.g., "meta_events")
 * @param {MigrationStorage} storage - The migration storage instance
 * @returns {Promise<void>}
 */
async function deleteNodeType(nodeName, storage) {
    const nodeNameTyped = stringToNodeName(nodeName);
    const nodeKeys = storage.listMaterializedNodes();
    for await (const nodeKey of nodeKeys) {
        const parsed = deserializeNodeKey(nodeKey);
        if (parsed.head === nodeNameTyped) {
            await storage.delete(nodeKey);
        }
    }
}

/**
 * @param {GeneratorsCapabilities} capabilities
 * @returns {function(MigrationStorage): Promise<void>}
 */
function migrationCallback(capabilities) {
    return async (storage) => {
        capabilities.logger.logInfo({}, "Migration tries to keep everything.");
        await keepNodeType("all_events", storage);
        await keepNodeType("sorted_events_descending", storage);
        await keepNodeType("sorted_events_ascending", storage);
        await keepNodeType("last_entries", storage);
        await keepNodeType("first_entries", storage);
        await keepNodeType("events_count", storage);
        await keepNodeType("config", storage);
        await keepNodeType("meta_events", storage);
        await keepNodeType("event", storage);
        await keepNodeType("basic_context", storage);
        await keepNodeType("calories", storage);
        await keepNodeType("event_transcription", storage);
        await keepNodeType("transcription", storage);
        await keepNodeType("diary_most_important_info_summary", storage);
    };
}

/**
 * Deletes all node values.
 * @param {GeneratorsCapabilities} capabilities
 * @param {MigrationStorage} storage
 * @returns {Promise<void>}
 */
async function deleteAllCallback(capabilities, storage) {
    // A conservative approach.
    // The effect is that all computed values will be invalidated.
    capabilities.logger.logInfo({}, "Migration: deleting all node values");
    for await (const nodeKey of storage.listMaterializedNodes()) {
        await storage.delete(nodeKey);
    }
}

module.exports = {
    deleteAllCallback,
    migrationCallback,
    keepNodeType,
    deleteNodeType,
};
