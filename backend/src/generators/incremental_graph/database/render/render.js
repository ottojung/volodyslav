/**
 * Filesystem rendering module for the incremental-graph database.
 *
 * Provides renderToFilesystem(), which reconciles every raw LevelDB key/value
 * pair in one database sublevel with a directory tree.  Only files whose
 * content has changed are rewritten; files that no longer correspond to a
 * database key are deleted.
 *
 * The inverse operation — reading the directory tree back into the database
 * — is provided by scanFromFilesystem() in scan.js.
 */

const { validateTopLevelSublevel } = require('./sublevel');
const { makeDbToFsAdapter } = require('../unification');
const { unifyStores } = require('../unification');

/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../../logger').Logger} Logger */

/**
 * Capabilities required by renderToFilesystem.
 * @typedef {object} RenderCapabilities
 * @property {FileCreator} creator - Creates files (and parent directories) on disk.
 * @property {FileWriter} writer - Writes serialised content to a file.
 * @property {FileReader} reader - Reads file content as a UTF-8 string.
 * @property {FileChecker} checker - Checks whether a path is a file or directory.
 * @property {FileDeleter} deleter - Deletes files and directories during reconciliation.
 * @property {DirScanner} scanner - Scans a directory (non-recursive).
 * @property {Logger} logger - Logger for progress messages.
 */

/**
 * Dumps every raw key/value pair from one top-level database sublevel to a
 * directory tree rooted at `outputDir`, using gentle unification.
 *
 * Only files whose content has changed since the last render are rewritten.
 * Files in the output directory that no longer have a corresponding database
 * key are deleted.
 *
 * This function is the inverse of scanFromFilesystem() in scan.js.
 *
 * @param {RenderCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to dump.
 * @param {string} outputDir - Absolute path of the directory to write into.
 * @param {string} sublevel - Top-level database sublevel to render (e.g. "x", "_meta").
 * @returns {Promise<void>}
 */
async function renderToFilesystem(capabilities, rootDatabase, outputDir, sublevel) {
    const validatedSublevel = validateTopLevelSublevel(sublevel);

    // Ensure the output directory exists so that a subsequent scanFromFilesystem
    // call can find it even when the sublevel is empty and no files are written.
    if (!await capabilities.checker.directoryExists(outputDir)) {
        await capabilities.creator.createDirectory(outputDir);
    }

    const adapter = makeDbToFsAdapter(capabilities, rootDatabase, outputDir, validatedSublevel);
    const stats = await unifyStores(adapter);

    capabilities.logger.logInfo(
        { outputDir, sublevel: validatedSublevel, count: stats.sourceCount, ...stats },
        'Rendered database to filesystem'
    );
}

module.exports = {
    renderToFilesystem,
};

