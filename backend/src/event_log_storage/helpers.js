const path = require('path');
const { targetPath } = require('../event/asset');
const event = require('../event');

/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../filesystem/file').ExistingFile} ExistingFile */
/** @typedef {import('./storage_class').EventLogStorage} EventLogStorage */

/**
 * @typedef {object} AppendCapabilities
 * @property {FileAppender} appender
 */

/**
 * @typedef {object} CopyAssetCapabilities
 * @property {FileCreator} creator
 * @property {FileCopier} copier
 * @property {Environment} environment
 */

/**
 * @typedef {object} CleanupAssetCapabilities
 * @property {FileDeleter} deleter
 * @property {Environment} environment
 * @property {Logger} logger
 */

/**
 * Append entries serialized as JSON to a file.
 * @param {AppendCapabilities} capabilities
 * @param {ExistingFile} file
 * @param {Array<import('../event').Event>} entries
 */
async function appendEntriesToFile(capabilities, file, entries) {
    for (const entry of entries) {
        const serialized = event.serialize(entry);
        const eventString = JSON.stringify(serialized, null, '\t');
        await capabilities.appender.appendFile(file, eventString + '\n');
    }
}

/**
 * Copy queued assets into the repository.
 * @param {CopyAssetCapabilities} capabilities
 * @param {import('../event').Asset[]} assets
 */
async function copyAssets(capabilities, assets) {
    for (const asset of assets) {
        const target = targetPath(capabilities, asset);
        const targetDir = path.dirname(target);
        await capabilities.creator.createDirectory(targetDir);
        await capabilities.copier.copyFile(asset.file, target);
    }
}

/**
 * Remove all copied assets on failure.
 * @param {CleanupAssetCapabilities} capabilities
 * @param {EventLogStorage} eventLogStorage
 */
async function cleanupAssets(capabilities, eventLogStorage) {
    const assets = eventLogStorage.getNewAssets();
    for (const asset of assets) {
        const assetPath = targetPath(capabilities, asset);
        try {
            await capabilities.deleter.deleteFile(assetPath);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            capabilities.logger.logWarning(
                { file: assetPath, error: msg },
                `Failed to remove asset file ${assetPath}. This may be due to the file being in use or not existing.`
            );
        }
    }
}

module.exports = { appendEntriesToFile, copyAssets, cleanupAssets };
