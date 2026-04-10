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
 * Key space: raw LevelDB keys for the target sublevel
 * (e.g. "!x!!values!{\"head\":\"all_events\",\"args\":[]}").
 * - listSourceKeys walks the input directory and maps each file path to its
 *   corresponding raw DB key via relativePathToKey().
 * - listTargetKeys iterates the database sublevel directly.
 * - readSource reads and parses the file content.
 * - readTarget reads the deserialized value from the database.
 * - equals compares deserialized (JSON) values using stable stringify.
 * - putTarget and deleteTarget buffer operations and flush in chunks.
 */

const path = require('path');
const { relativePathToKey, keyToRelativePath, parseValue } = require('../render');
const { stableStringify } = require('./db_to_db');
const { RAW_BATCH_CHUNK_SIZE } = require('../constants');

/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./core').UnificationAdapter} UnificationAdapter */

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
     * Convert a raw LevelDB key back to the absolute file path.
     * rawKey format: "!{sublevel}!..." where the outer prefix is stripped
     * to get the inner key within the sublevel.
     * We use relativePathToKey's inverse: keyToRelativePath + strip prefix.
     * @param {string} rawKey
     * @returns {string}
     */
    function rawKeyToAbsPath(rawKey) {
        const fullRelPath = keyToRelativePath(rawKey);
        const relPath = fullRelPath.slice(sublevelPathPrefix.length);
        return path.join(inputDir, relPath.split('/').join(path.sep));
    }

    /** @type {Array<{ key: string, value: unknown }>} */
    let pendingPuts = [];
    /** @type {string[]} */
    let pendingDeletes = [];

    async function flushPuts() {
        while (pendingPuts.length >= RAW_BATCH_CHUNK_SIZE) {
            await rootDatabase._rawPutAll(pendingPuts.splice(0, RAW_BATCH_CHUNK_SIZE));
        }
    }

    async function flushDeletes() {
        while (pendingDeletes.length >= RAW_BATCH_CHUNK_SIZE) {
            await rootDatabase._rawDeleteKeys(pendingDeletes.splice(0, RAW_BATCH_CHUNK_SIZE));
        }
    }

    return {
        async *listSourceKeys() {
            const allFiles = await walkFilesRecursively(capabilities, inputDir);
            for (const absPath of allFiles) {
                yield absPathToRawKey(absPath);
            }
        },

        async *listTargetKeys() {
            for await (const [rawKey] of rootDatabase._rawEntriesForSublevel(sublevel)) {
                yield rawKey;
            }
        },

        async readSource(rawKey) {
            const absPath = rawKeyToAbsPath(rawKey);
            const content = await capabilities.reader.readFileAsText(absPath);
            return parseValue(content);
        },

        async readTarget(rawKey) {
            return await rootDatabase._rawGet(rawKey);
        },

        equals(sv, tv) {
            return stableStringify(sv) === stableStringify(tv);
        },

        async putTarget(rawKey, value) {
            pendingPuts.push({ key: rawKey, value });
            await flushPuts();
        },

        async deleteTarget(rawKey) {
            pendingDeletes.push(rawKey);
            await flushDeletes();
        },

        async commit() {
            if (pendingPuts.length > 0) {
                await rootDatabase._rawPutAll(pendingPuts.splice(0));
            }
            if (pendingDeletes.length > 0) {
                await rootDatabase._rawDeleteKeys(pendingDeletes.splice(0));
            }
        },

        async rollback() {
            pendingPuts = [];
            pendingDeletes = [];
        },
    };
}

module.exports = {
    makeFsToDbAdapter,
};
