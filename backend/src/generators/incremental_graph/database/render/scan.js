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

const path = require('path');
const { relativePathToKey, parseValue } = require('./encoding');
const { validateTopLevelSublevel } = require('./sublevel');

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
 * Recursively collects the absolute paths of every file under `dir` using the
 * capabilities pattern. Directories are traversed but not included in the result.
 *
 * @param {ScanCapabilities} capabilities
 * @param {string} dir - Root directory to walk.
 * @returns {Promise<string[]>} Absolute paths of all files found.
 */
async function walkFilesRecursively(capabilities, dir) {
    const children = await capabilities.scanner.scanDirectory(dir);
    /** @type {string[]} */
    const files = [];
    for (const child of children) {
        if (await capabilities.checker.directoryExists(child.path)) {
            const nested = await walkFilesRecursively(capabilities, child.path);
            files.push(...nested);
        } else if (await capabilities.checker.fileExists(child.path)) {
            files.push(child.path);
        }
    }
    return files;
}

/**
 * Reads every file from a directory tree rooted at `inputDir` and writes the
 * corresponding key/value pairs into one top-level database sublevel while
 * preserving all other top-level database sublevels.
 *
 * This function FIRST clears all existing entries for the requested sublevel,
 * then imports the snapshot from the resolved directory.  This guarantees that
 * keys present in the database but absent from the snapshot (i.e., deleted
 * entries) do not survive, preserving the bijection guarantee.
 *
 * For each file found under the resolved input directory:
 *   - The path relative to that directory is converted back to a raw LevelDB
 *     key via relativePathToKey().
 *   - The file content is parsed via parseValue() and stored at that key.
 *
 * Calling scanFromFilesystem() on a directory produced by renderToFilesystem()
 * restores the database to exactly its original state (bijection guarantee).
 *
 * Works for any valid top-level sublevel, including hostname staging namespaces
 * (e.g. `_h_myhostname`).  Callers performing hostname staging should pass
 * `'_h_' + hostname` as the sublevel argument.
 *
 * Memory policy: file paths and parsed values are collected up-front (Phase 1)
 * before mutating the database.  This preserves the atomicity guarantee: if
 * reading or parsing fails, the database is left unchanged.  It is acceptable
 * to keep arbitrarily many keys (and bounded-size values) in RAM; chunking is
 * needed only for potentially unbounded value payloads and to avoid oversized
 * LevelDB batch writes.  Writes are issued in chunks of RAW_BATCH_CHUNK_SIZE
 * via _rawPutAll.
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

    // Phase 1: Walk, read, and parse all entries before mutating the database.
    // This preserves the atomicity guarantee: if any read or parse step fails,
    // the database is left completely unchanged.
    const allFiles = await walkFilesRecursively(capabilities, inputDir);

    /** @type {Array<{ key: string, value: unknown }>} */
    const entries = [];
    let count = 0;
    const sublevelPathPrefix = validatedSublevel + '/';

    for (const absPath of allFiles) {
        const relPath = path.relative(inputDir, absPath);
        const normalizedRelPath = relPath.split(path.sep).join('/');
        const key = relativePathToKey(sublevelPathPrefix + normalizedRelPath);
        const content = await capabilities.reader.readFileAsText(absPath);
        const value = parseValue(content);
        entries.push({ key, value });
        count++;
    }

    // Phase 2: After successful validation, replace only this sublevel's data.
    // _rawDeleteSublevel deletes only the keys for validatedSublevel (e.g. all
    // !x!... or !_meta!... entries) without touching other sublevels.
    // _rawPutAll writes entries in chunks of RAW_BATCH_CHUNK_SIZE so large
    // snapshots do not produce a single oversized batch.
    await rootDatabase._rawDeleteSublevel(validatedSublevel);
    await rootDatabase._rawPutAll(entries);
    capabilities.logger.logInfo(
        { inputDir, sublevel: validatedSublevel, count },
        'Scanned database from filesystem'
    );
}

module.exports = {
    scanFromFilesystem,
    isScanInputDirMissingError,
};
