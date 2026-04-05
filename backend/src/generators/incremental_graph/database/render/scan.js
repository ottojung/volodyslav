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
const { relativePathToKey, parseValue, keyToRelativePath } = require('./encoding');
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
 * This function FIRST clears all existing entries from rootDatabase, then
 * imports the snapshot from the resolved directory.  This guarantees that keys
 * present in the database but absent from the snapshot (i.e., deleted entries)
 * do not survive, preserving the bijection guarantee.
 *
 * For each file found under the resolved input directory:
 *   - The path relative to that directory is converted back to a raw LevelDB
 *     key via relativePathToKey().
 *   - The file content is parsed via parseValue() and stored at that key.
 *
 * Calling scanFromFilesystem() on a directory produced by renderToFilesystem()
 * restores the database to exactly its original state (bijection guarantee).
 *
 * @param {ScanCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to populate.
 * @param {string} inputDir - Absolute path of the directory to read from.
 * @param {string} sublevel - Top-level database sublevel to scan into (e.g. "x", "_meta").
 * @returns {Promise<void>}
 */
async function scanFromFilesystem(capabilities, rootDatabase, inputDir, sublevel) {
    const validatedSublevel = validateTopLevelSublevel(sublevel);
    const hasInputDirectory = await capabilities.checker.directoryExists(inputDir);
    // Phase 1: Walk, read, and parse all entries before mutating the database.
    const allFiles = hasInputDirectory ? await walkFilesRecursively(capabilities, inputDir) : [];

    /** @type {Array<{ key: string, value: unknown }>} */
    const entries = [];
    let count = 0;
    const sublevelPrefix = validatedSublevel + '/';

    for (const absPath of allFiles) {
        const relPath = path.relative(inputDir, absPath);
        const normalizedRelPath = relPath.split(path.sep).join('/');
        const key = relativePathToKey(sublevelPrefix + normalizedRelPath);
        const content = await capabilities.reader.readFileAsText(absPath);
        const value = parseValue(content);
        entries.push({ key, value });
        count++;
    }

    /** @type {Array<{ key: string, value: unknown }>} */
    const preservedEntries = [];
    for await (const [key, value] of rootDatabase._rawEntries()) {
        const relPath = keyToRelativePath(key);
        if (!relPath.startsWith(sublevelPrefix)) {
            preservedEntries.push({ key, value });
        }
    }

    // Phase 2: After successful validation, clear and repopulate the database.
    await rootDatabase._rawDeleteAll();
    await rootDatabase._rawPutAll([...preservedEntries, ...entries]);
    capabilities.logger.logInfo(
        { inputDir, sublevel: validatedSublevel, count },
        'Scanned database from filesystem'
    );
}

module.exports = {
    scanFromFilesystem,
};
