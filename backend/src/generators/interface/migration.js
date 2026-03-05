
// This file contains the current migration callback.

/**
 * @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities
 */

/**
 * @typedef {import('../incremental_graph/migration_storage').MigrationStorage} MigrationStorage
 */

/**
 * @param {GeneratorsCapabilities} capabilities
 * @returns {function(MigrationStorage): Promise<void>}
 */
function migrationCallback(capabilities) {
    return async (storage) => {
        // A temporary conservative approach.
        // The effect is that all computed values will be invalidated.
        // This code will be replaced by more targeted migrations in the future.
        capabilities.logger.logInfo({}, "Migration: deleting all node values");
        for await (const nodeKey of storage.listMaterializedNodes()) {
            await storage.delete(nodeKey);
        }
    };
}

module.exports = {
    migrationCallback,
};
