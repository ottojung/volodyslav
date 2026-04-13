/**
 * Filesystem scanning module for the incremental-graph database.
 *
 * Provides scanFromFilesystem(), which restores a database from a directory
 * tree previously written by renderToFilesystem() (in render.js).
 *
 * Design constraints
 * ------------------
 *  - No JSON operations in this module; value parsing is delegated to encoding.js.
 *  - No `any` or `*` types; all values flow through the `unknown` type.
 *  - No type casting.
 */

const { validateTopLevelSublevel } = require('./sublevel');
const { makeFsToDbAdapter, unifyStores } = require('../unification');

/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../../logger').Logger} Logger */

/**
 * Capabilities required by scanFromFilesystem.
 * @typedef {object} ScanCapabilities
 * @property {FileReader} reader - Reads file content as a UTF-8 string.
 * @property {FileChecker} checker - Checks whether a path is a file or directory.
 * @property {DirScanner} scanner - Scans directory contents (non-recursive).
 * @property {Logger} logger - Logger for progress messages.
 */

/**
 * Thrown when the `inputDir` passed to scanFromFilesystem() does not exist on
 * disk.  Callers must render (or otherwise create) the snapshot directory
 * before scanning; a missing directory is treated as a programming error rather
 * than an empty snapshot to prevent silent data loss.
 */
class ScanInputDirMissingError extends Error {
    /**
     * @param {string} inputDir
     * @param {string} sublevel
     */
    constructor(inputDir, sublevel) {
        super(`scanFromFilesystem: input directory does not exist: ${inputDir} (sublevel: ${sublevel})`);
        this.name = 'ScanInputDirMissingError';
        this.inputDir = inputDir;
        this.sublevel = sublevel;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScanInputDirMissingError}
 */
function isScanInputDirMissingError(object) {
    return object instanceof ScanInputDirMissingError;
}

/**
 * Reads every file from a directory tree rooted at `inputDir` and reconciles
 * the corresponding key/value pairs into one top-level database sublevel.
 *
 * Uses gentle unification: only keys whose value differs are written; keys
 * present in the database but absent from the snapshot are deleted.  This
 * avoids the previous clear-then-rewrite approach and minimises I/O when
 * the snapshot is largely unchanged.
 *
 * Works for any valid top-level sublevel, including hostname staging namespaces
 * (e.g. `_h_myhostname`).
 *
 * @param {ScanCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to populate.
 * @param {string} inputDir - Absolute path of the directory to read from.
 * @param {string} sublevel - Top-level database sublevel to scan into (e.g. "x", "_meta", "_h_myhostname").
 * @returns {Promise<void>}
 */
async function scanFromFilesystem(capabilities, rootDatabase, inputDir, sublevel) {
    const validatedSublevel = validateTopLevelSublevel(sublevel);

    // Fail fast: a missing input directory is a programming error, not an
    // "empty snapshot".  Silently treating it as empty would delete all keys
    // for this sublevel with no data written back.
    if (!await capabilities.checker.directoryExists(inputDir)) {
        throw new ScanInputDirMissingError(inputDir, validatedSublevel);
    }

    const adapter = makeFsToDbAdapter(capabilities, rootDatabase, inputDir, validatedSublevel);
    const stats = await unifyStores(adapter);

    capabilities.logger.logInfo(
        { inputDir, sublevel: validatedSublevel, count: stats.sourceCount, ...stats },
        'Scanned database from filesystem'
    );
}

module.exports = {
    scanFromFilesystem,
    isScanInputDirMissingError,
};

