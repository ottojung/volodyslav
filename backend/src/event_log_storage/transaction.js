const path = require('path');
const gitstore = require('../gitstore');
const configStorage = require('../config/storage');

const { appendEntriesToFile, copyAssets, cleanupAssets } = require('./helpers');
const { EventLogStorageClass } = require('./storage_class');

/** @typedef {import('./storage_class').EventLogStorage} EventLogStorage */
/** @typedef {import('./helpers').CopyAssetCapabilities} CopyAssetCapabilities */
/** @typedef {import('./helpers').AppendCapabilities} AppendCapabilities */
/** @typedef {import('./helpers').CleanupAssetCapabilities} CleanupAssetCapabilities */
/** @typedef {import('./storage_class').EventLogStorageCapabilities} EventLogStorageCapabilities */
/** @template T @typedef {(eventLogStorage: EventLogStorage) => Promise<T>} Transformation */

/**
 * Perform a Git-backed transaction using the given storage and transformation.
 * @template T
 * @param {EventLogStorageCapabilities} capabilities
 * @param {EventLogStorage} eventLogStorage
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function performGitTransaction(capabilities, eventLogStorage, transformation) {
    return await gitstore.transaction(capabilities, async (store) => {
        const workTree = await store.getWorkTree();
        const dataPath = path.join(workTree, 'data.json');
        const configPath = path.join(workTree, 'config.json');
        const dataFile = await capabilities.checker
            .instantiate(dataPath)
            .catch(() => null);
        const configFile = await capabilities.checker
            .instantiate(configPath)
            .catch(() => null);

        eventLogStorage.dataFile = dataFile;
        eventLogStorage.configFile = configFile;

        const result = await transformation(eventLogStorage);

        const newEntries = eventLogStorage.getNewEntries();
        const newConfig = eventLogStorage.getNewConfig();
        let needsCommit = false;

        if (newEntries.length > 0) {
            const existingDataFile =
                dataFile == null ? await capabilities.creator.createFile(dataPath) : dataFile;
            await appendEntriesToFile(capabilities, existingDataFile, newEntries);
            needsCommit = true;
        }

        if (newConfig !== null) {
            await configStorage.writeConfig(capabilities, configPath, newConfig);
            needsCommit = true;
        }

        if (needsCommit) {
            await store.commit('Event log storage update');
        }

        const assets = eventLogStorage.getNewAssets();
        await copyAssets(capabilities, assets);

        return result;
    });
}

/**
 * Apply a transformation within a Git-backed event log transaction.
 * @template T
 * @param {EventLogStorageCapabilities} capabilities
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    const eventLogStorage = new EventLogStorageClass(capabilities);
    try {
        return await performGitTransaction(capabilities, eventLogStorage, transformation);
    } catch (error) {
        await cleanupAssets(capabilities, eventLogStorage);
        throw error;
    }
}

module.exports = { transaction };
