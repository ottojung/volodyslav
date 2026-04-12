/**
 * Filesystem-to-DB unification adapter.
 *
 * Unifies the contents of a snapshot directory into one top-level database
 * sublevel.  Only puts keys whose deserialized value differs from what is
 * already in the database; deletes keys absent from the snapshot.
 *
 * This adapter is a drop-in replacement for the previous clear-then-write
 * strategy in scanFromFilesystem: instead of deleting the entire sublevel and
 * rewriting all entries, it issues only the necessary puts and deletes.
 *
 * Writes are applied immediately (no buffering).  Atomicity is not guaranteed
 * at this level; it is provided at a higher level by the replica-cutover
 * mechanism.  The target sublevel is always an inactive replica that is not
 * read until cutover succeeds.
 *
 * Key space: raw LevelDB keys for the target sublevel
 * (e.g. "!x!!values!{\"head\":\"all_events\",\"args\":[]}").
 * - listSourceKeys walks the input directory and maps each file path to its
 *   corresponding raw DB key via relativePathToKey().
 * - listTargetKeys iterates the database sublevel directly.
 * - readSource reads and parses the file content.
 * - readTarget reads the deserialized value from the database on-demand.
 * - equals compares deserialized (JSON) values using JSON.stringify.
 * - putTarget and deleteTarget write/delete immediately.
 */

const path = require('path');
const { relativePathToKey, parseValue } = require('../encoding');

/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./core').UnificationAdapter} UnificationAdapter */

/**
 * Thrown when readSource() is called for a key that was never recorded in
 * listSourceKeys().  This is a programming error (the merge-join should only
 * call readSource() for keys it received from listSourceKeys()).
 */
class UnrecordedKeyError extends Error {
    /**
     * @param {string} rawKey
     */
    constructor(rawKey) {
        super(`fs_to_db readSource: no path recorded for key '${rawKey}'`);
        this.name = 'UnrecordedKeyError';
        this.rawKey = rawKey;
    }
}

/**
 * @param {unknown} object
 * @returns {object is UnrecordedKeyError}
 */
function isUnrecordedKeyError(object) {
    return object instanceof UnrecordedKeyError;
}

/**
 * Thrown when two different file paths in the snapshot directory decode to the
 * same raw LevelDB key (e.g. via differing percent-escape casing like %2e vs
 * %2E).  Duplicate keys would violate the strictly-sorted-stream requirement of
 * the merge-join and produce non-deterministic unification results.
 */
class DuplicateSourceKeyError extends Error {
    /**
     * @param {string} rawKey
     * @param {string} path1 - First file path that decoded to rawKey.
     * @param {string} path2 - Second file path that decoded to rawKey.
     */
    constructor(rawKey, path1, path2) {
        super(`fs_to_db listSourceKeys: key '${rawKey}' maps to two paths: '${path1}' and '${path2}'`);
        this.name = 'DuplicateSourceKeyError';
        this.rawKey = rawKey;
        this.path1 = path1;
        this.path2 = path2;
    }
}

/**
 * @param {unknown} object
 * @returns {object is DuplicateSourceKeyError}
 */
function isDuplicateSourceKeyError(object) {
    return object instanceof DuplicateSourceKeyError;
}

/**
 * Capabilities required by the FS→DB adapter.
 * @typedef {object} FsToDbCapabilities
 * @property {FileReader} reader - Reads file content as a UTF-8 string.
 * @property {FileChecker} checker - Checks whether a path is a file or directory.
 * @property {DirScanner} scanner - Scans directory contents (non-recursive).
 */

/**
 * Recursively collects the absolute paths of every file under `dir`.
 *
 * @param {FsToDbCapabilities} capabilities
 * @param {string} dir
 * @returns {Promise<string[]>}
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
 * Create a filesystem-to-DB unification adapter.
 *
 * @param {FsToDbCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {string} inputDir - Absolute path of the snapshot directory.
 * @param {string} sublevel - Validated top-level sublevel name (e.g. "x", "_meta").
 * @returns {UnificationAdapter}
 */
function makeFsToDbAdapter(capabilities, rootDatabase, inputDir, sublevel) {
    const sublevelPathPrefix = sublevel + '/';

    /**
     * Convert an absolute file path under inputDir to the raw LevelDB key.
     * @param {string} absPath
     * @returns {string}
     */
    function absPathToRawKey(absPath) {
        const relPath = path.relative(inputDir, absPath);
        const normalizedRelPath = relPath.split(path.sep).join('/');
        return relativePathToKey(sublevelPathPrefix + normalizedRelPath);
    }

    /**
     * Map from raw LevelDB key to the original absolute file path discovered
     * during listSourceKeys().  Preserved because keyToRelativePath() always
     * produces the canonical (uppercase) encoding, which would fail to match
     * manually-created snapshot files that use tolerantly-accepted lowercase
     * escape sequences (e.g. %2e instead of %2E).  This map lets readSource()
     * use the actual discovered path for reading, preserving case exactly.
     *
     * Memory: O(num_source_files × avg_path_length) — key strings only, no values.
     * @type {Map<string, string>}
     */
    const sourceKeyToAbsPath = new Map();

    const rawKeyPrefix = '!' + sublevel + '!';

    return {
        async *listSourceKeys() {
            // Collect all file paths, map each to its raw DB key, then sort.
            // Sorting is required for the merge-join in core.js.
            // The sourceKeyToAbsPath map is populated here so readSource() can
            // use the original discovered path (P2: preserve path casing).
            //
            // Memory: O(num_files × avg_rawkey_length).  Only key strings are
            // held; file contents are never read during key enumeration.
            const allFiles = await walkFilesRecursively(capabilities, inputDir);
            /** @type {Array<{rawKey: string, absPath: string}>} */
            const entries = allFiles.map(absPath => ({ rawKey: absPathToRawKey(absPath), absPath }));
            // Sort in UTF-8 byte order using decorate-sort-undecorate so each
            // buffer is computed once per entry (not once per comparison).
            /** @type {Array<{rawKey: string, absPath: string, buf: Buffer}>} */
            const decorated = entries.map(e => ({ rawKey: e.rawKey, absPath: e.absPath, buf: Buffer.from(e.rawKey, 'utf8') }));
            decorated.sort((a, b) => Buffer.compare(a.buf, b.buf));
            /** @type {{rawKey: string, absPath: string, buf: Buffer} | undefined} */
            let prev;
            for (const item of decorated) {
                // Detect duplicate keys (two file paths that decode to the same
                // raw DB key, e.g. differing only by percent-escape casing).
                // Duplicates violate the strictly-sorted-stream requirement.
                if (prev !== undefined && prev.rawKey === item.rawKey) {
                    throw new DuplicateSourceKeyError(item.rawKey, prev.absPath, item.absPath);
                }
                sourceKeyToAbsPath.set(item.rawKey, item.absPath);
                yield item.rawKey;
                prev = item;
            }
        },

        async *listTargetKeys() {
            // Stream target keys in LevelDB order (already sorted); no value
            // caching needed since readTarget() does an on-demand lookup.
            for await (const rawKey of rootDatabase._rawKeysForSublevel(sublevel)) {
                yield rawKey;
            }
        },

        async readSource(rawKey) {
            // Use the original discovered path to preserve filename casing.
            // keyToRelativePath() always produces canonical uppercase encoding,
            // which would fail for manually-created files with lowercase escapes.
            const absPath = sourceKeyToAbsPath.get(rawKey);
            if (absPath === undefined) {
                throw new UnrecordedKeyError(rawKey);
            }
            const content = await capabilities.reader.readFileAsText(absPath);
            return parseValue(content);
        },

        async readTarget(rawKey) {
            // On-demand read: O(log n) per call, O(1) memory.
            const innerKey = rawKey.slice(rawKeyPrefix.length);
            return await rootDatabase._rawGetInSublevel(sublevel, innerKey);
        },

        equals(sv, tv) {
            return JSON.stringify(sv) === JSON.stringify(tv);
        },

        async putTarget(rawKey, value) {
            // Write immediately with sync:false. O(max_value_size) memory: only one value live at once.
            // flush() will call rootDatabase._rawSync() to do the one final fsync.
            await rootDatabase._rawPut(rawKey, value);
        },

        async deleteTarget(rawKey) {
            // Delete immediately with sync:false. No buffering needed.
            await rootDatabase._rawDel(rawKey);
        },

        async flush() {
            // One final fsync to flush all preceding sync:false writes to durable storage.
            await rootDatabase._rawSync();
        },
    };
}

module.exports = {
    makeFsToDbAdapter,
    UnrecordedKeyError,
    isUnrecordedKeyError,
    DuplicateSourceKeyError,
    isDuplicateSourceKeyError,
};
