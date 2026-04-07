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
 * Thrown when the hostname string passed to scanHostnameFromFilesystem() is
 * invalid (empty, or contains characters not allowed in a staging namespace key).
 */
class InvalidHostnameError extends Error {
    /**
     * @param {string} hostname
     * @param {string} reason
     */
    constructor(hostname, reason) {
        super(`Invalid hostname '${hostname}': ${reason}`);
        this.name = 'InvalidHostnameError';
        this.hostname = hostname;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidHostnameError}
 */
function isInvalidHostnameError(object) {
    return object instanceof InvalidHostnameError;
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
 * @param {ScanCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to populate.
 * @param {string} inputDir - Absolute path of the directory to read from.
 * @param {string} sublevel - Top-level database sublevel to scan into (e.g. "x", "_meta").
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
    // !x!... or !_meta!... entries) without touching other sublevels, avoiding
    // the need to read-and-rewrite the entire database.
    await rootDatabase._rawDeleteSublevel(validatedSublevel);
    await rootDatabase._rawPutAll(entries);
    capabilities.logger.logInfo(
        { inputDir, sublevel: validatedSublevel, count },
        'Scanned database from filesystem'
    );
}

/**
 * Validate a hostname string for use as a staging namespace key.
 * Must be non-empty and must not contain `/`, `\`, or `!`.
 *
 * @param {string} hostname
 * @returns {string} The validated hostname.
 * @throws {Error} If the hostname is invalid.
 */
function validateHostname(hostname) {
    if (typeof hostname !== 'string' || hostname.length === 0) {
        throw new InvalidHostnameError(hostname, 'must be a non-empty string');
    }
    if (hostname.includes('/') || hostname.includes('\\') || hostname.includes('!')) {
        throw new InvalidHostnameError(hostname, "must not contain '/', '\\\\', or '!'");
    }
    return hostname;
}

/**
 * Parse a path-component from a rendered `r/` snapshot into the
 * LevelDB sub-database name and key content.
 *
 * The files inside an `r/` snapshot directory (produced by renderToFilesystem)
 * are structured as `<sublevel>/<head>/<arg1>/...` for node-key data and
 * `<sublevel>/<plainKey>` for meta entries.  This function decodes the path
 * using a fake namespace `x` so the existing relativePathToKey encoding can be
 * re-used, then strips the namespace prefix to yield the sublevel name and key.
 *
 * @param {string} relPath - Path relative to the `r/` directory, e.g. `values/event/alice`.
 * @returns {{ sublevelName: string, keyContent: string }}
 * @throws {Error} if the path cannot be decoded.
 */
function parseHostnameSnapshotPath(relPath) {
    // Prepend a fake top-level namespace so relativePathToKey can apply depth-2
    // parsing.  We will strip the fake namespace prefix afterwards.
    const FAKE_NS = 'x';
    const rawKey = relativePathToKey(FAKE_NS + '/' + relPath);
    // rawKey format: !x!!<sublevel>!<keyContent>
    // Strip leading '!x!!'
    const prefix = '!' + FAKE_NS + '!!';
    if (!rawKey.startsWith(prefix)) {
        throw new Error(`Unexpected raw key format: ${rawKey}`);
    }
    const withoutNamespace = rawKey.slice(prefix.length);
    const bangIdx = withoutNamespace.indexOf('!');
    if (bangIdx < 0) {
        throw new Error(`Missing sublevel separator in raw key: ${rawKey}`);
    }
    const sublevelName = withoutNamespace.slice(0, bangIdx);
    const keyContent = withoutNamespace.slice(bangIdx + 1);
    return { sublevelName, keyContent };
}

/**
 * Scans the contents of a rendered `r/` directory into the hostname staging
 * namespace (`hostnames/<hostname>`) of the live database.
 *
 * This is the per-host import step during sync: before running the graph
 * merge, the remote host's snapshot is imported verbatim into the LevelDB
 * hostname namespace so the merge algorithm can compare node-by-node.
 *
 * The function first clears any existing data for `hostname`, then reads every
 * file under `inputDir` (which must exist) and writes it to the appropriate
 * sub-database of the hostname schema storage.
 *
 * Supported sub-databases: values, freshness, inputs, revdeps, counters,
 * timestamps, and meta (for version tracking).  Unknown sublevels are ignored
 * with a debug log so the function stays forward-compatible.
 *
 * @param {ScanCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The live database to write into.
 * @param {string} inputDir - Absolute path of the rendered `r/` directory to read from.
 * @param {string} hostname - The hostname to stage data under.
 * @returns {Promise<void>}
 */
async function scanHostnameFromFilesystem(capabilities, rootDatabase, inputDir, hostname) {
    const validatedHostname = validateHostname(hostname);

    if (!await capabilities.checker.directoryExists(inputDir)) {
        throw new ScanInputDirMissingError(inputDir, 'hostnames/' + validatedHostname);
    }

    // Clear stale data first so keys absent in the remote do not survive.
    await rootDatabase.clearHostnameStorage(validatedHostname);

    const allFiles = await walkFilesRecursively(capabilities, inputDir);

    // Phase 1: Read all files and collect (sublevelName, subkey, value) triples.
    /** @type {Array<{ sublevelName: string, subkey: string, value: unknown }>} */
    const graphEntries = [];
    let count = 0;

    for (const absPath of allFiles) {
        const relPath = path.relative(inputDir, absPath).split(path.sep).join('/');

        let sublevelName;
        let keyContent;
        try {
            ({ sublevelName, keyContent } = parseHostnameSnapshotPath(relPath));
        } catch (_err) {
            capabilities.logger.logDebug(
                { relPath, inputDir, hostname: validatedHostname },
                'scanHostnameFromFilesystem: skipping undecodable path'
            );
            continue;
        }

        const content = await capabilities.reader.readFileAsText(absPath);
        const value = parseValue(content);

        if (sublevelName === 'meta') {
            // Meta entries (e.g. version) are written separately via setHostnameMeta.
            await rootDatabase.setHostnameMeta(validatedHostname, keyContent, value);
        } else if (
            sublevelName === 'values' ||
            sublevelName === 'freshness' ||
            sublevelName === 'inputs' ||
            sublevelName === 'revdeps' ||
            sublevelName === 'counters' ||
            sublevelName === 'timestamps'
        ) {
            // Use _rawPutAllToHostname to avoid typed-storage value-type constraints;
            // the hostname storage is a staging area and values remain opaque until
            // the merge algorithm inspects them.
            graphEntries.push({ sublevelName, subkey: keyContent, value });
        } else {
            capabilities.logger.logDebug(
                { sublevelName, relPath, hostname: validatedHostname },
                'scanHostnameFromFilesystem: unknown sublevel, skipping'
            );
            continue;
        }
        count++;
    }

    // Phase 2: Bulk-write all graph entries.
    await rootDatabase._rawPutAllToHostname(validatedHostname, graphEntries);

    capabilities.logger.logInfo(
        { inputDir, hostname: validatedHostname, count },
        'Scanned hostname storage from filesystem'
    );
}

module.exports = {
    scanFromFilesystem,
    scanHostnameFromFilesystem,
    isScanInputDirMissingError,
    InvalidHostnameError,
    isInvalidHostnameError,
};
