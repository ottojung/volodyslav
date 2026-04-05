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

/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../logger').Logger} Logger */

/**
 * Capabilities required by scanFromFilesystem.
 * @typedef {object} ScanCapabilities
 * @property {FileReader} reader - Reads file content as a UTF-8 string.
 * @property {FileChecker} checker - Checks whether a path is a file or directory.
 * @property {DirScanner} scanner - Scans directory contents (non-recursive).
 * @property {Logger} logger - Logger for progress messages.
 */

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
 * Reads every file from a directory tree and writes the corresponding
 * key/value pairs into a LevelDB database.
 *
 * This function FIRST clears all existing entries from rootDatabase, then
 * imports the snapshot from inputDir.  This guarantees that keys present in
 * the database but absent from the snapshot (i.e., deleted entries) do not
 * survive, preserving the bijection guarantee.
 *
 * For each file found under `inputDir`:
 *   - The path relative to `inputDir` is converted back to a raw LevelDB
 *     key via relativePathToKey().
 *   - The file content is parsed via parseValue() and stored at that key.
 *
 * Calling scanFromFilesystem() on a directory produced by renderToFilesystem()
 * restores the database to exactly its original state (bijection guarantee).
 *
 * @param {ScanCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to populate.
 * @param {string} inputDir - Absolute path of the directory to read from.
 * @returns {Promise<void>}
 */
async function scanFromFilesystem(capabilities, rootDatabase, inputDir) {
    // Phase 1: Walk, read, and parse all entries before mutating the database.
    const allFiles = await walkFilesRecursively(capabilities, inputDir);

    // Use plain string keys: relativePathToKey reconstructs raw root-level
    // LevelDB keys including sublevel prefixes such as `!x!!values!...`.
    /** @type {Array<{ key: string, value: unknown }>} */
    const entries = [];
    let count = 0;

    for (const absPath of allFiles) {
        const relPath = path.relative(inputDir, absPath);
        const normalizedRelPath = relPath.split(path.sep).join('/');
        const key = relativePathToKey(normalizedRelPath);
        const content = await capabilities.reader.readFileAsText(absPath);
        const value = parseValue(content);
        entries.push({ key, value });
        count++;
    }

    // Phase 2: After successful validation, clear and repopulate the database.
    await rootDatabase._rawDeleteAll();
    await rootDatabase._rawPutAll(entries);
    capabilities.logger.logInfo(
        { inputDir, count },
        'Scanned database from filesystem'
    );
}

module.exports = {
    scanFromFilesystem,
};
