
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
        throw new Error("No migration defined for this version" + String({ capabilities, storage }));
    };
}

module.exports = {
    migrationCallback,
};
