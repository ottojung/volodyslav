/**
 * DB-to-filesystem unification adapter.
 *
 * Unifies one top-level database sublevel into a snapshot directory.  Only
 * writes files whose serialised content differs from what is already on disk;
 * deletes files that are absent from the database.
 *
 * This adapter is a drop-in replacement for the previous clear-then-write
 * strategy in renderToFilesystem: instead of deleting the entire output
 * directory and rewriting every file, it issues only the necessary file writes
 * and deletes.
 *
 * Key space: relative file paths within the output directory
 * (e.g. "values/all_events", "meta/version").
 * - listSourceKeys iterates the database sublevel and maps each raw LevelDB key
 *   to its relative file path via keyToRelativePath().
 * - listTargetKeys walks the output directory and yields existing file paths.
 * - readSource reads the database value and serialises it to a JSON string.
 * - readTarget reads the existing file content.
 * - equals compares serialised content strings directly.
 * - putTarget writes (or overwrites) a file with the given content.
 * - deleteTarget deletes an existing file.
 *
 * Empty parent directories that result from file deletions are not removed.
 * The output directory is created automatically when the first file is written.
 */

const path = require('path');
const { keyToRelativePath, serializeValue } = require('../render/encoding');

/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./core').UnificationAdapter} UnificationAdapter */

/**
 * Capabilities required by the DB→FS adapter.
 * @typedef {object} DbToFsCapabilities
 * @property {FileCreator} creator - Creates files (and parent directories) on disk.
 * @property {FileWriter} writer - Writes content to a file.
 * @property {FileReader} reader - Reads file content as a UTF-8 string.
 * @property {FileChecker} checker - Checks whether a path is a file or directory.
 * @property {FileDeleter} deleter - Deletes files.
 * @property {DirScanner} scanner - Scans a directory (non-recursive).
 */

const PARENT_DIRECTORY_PREFIX = '..' + path.sep;

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isParentTraversal(relativePath) {
    return relativePath === '..' || relativePath.startsWith(PARENT_DIRECTORY_PREFIX);
}

/**
 * Resolves a relative path under baseDir and rejects paths that escape it.
 * @param {string} baseDir
 * @param {string} relPath
 * @returns {string}
 */
function resolveContainedPath(baseDir, relPath) {
    const resolvedBaseDir = path.resolve(baseDir);
    const resolvedPath = path.resolve(baseDir, relPath);
    const relativePath = path.relative(resolvedBaseDir, resolvedPath);
    if (relativePath === '') {
        throw new Error(
            `Invalid relative path '${relPath}': resolved path points to the directory itself`
        );
    }
    if (isParentTraversal(relativePath)) {
        throw new Error(
            `Invalid relative path '${relPath}': resolved path escapes the output directory '${resolvedBaseDir}'`
        );
    }
    return resolvedPath;
}

/**
 * Recursively collect all file paths under a directory.
 * @param {DbToFsCapabilities} capabilities
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
 * Create a DB-to-filesystem unification adapter.
 *
 * @param {DbToFsCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {string} outputDir - Absolute path of the target snapshot directory.
 * @param {string} sublevel - Validated top-level sublevel name (e.g. "x", "_meta").
 * @returns {UnificationAdapter}
 */
function makeDbToFsAdapter(capabilities, rootDatabase, outputDir, sublevel) {
    const sublevelPrefix = sublevel + '/';

    return {
        async *listSourceKeys() {
            for await (const [rawKey] of rootDatabase._rawEntriesForSublevel(sublevel)) {
                const fullRelPath = keyToRelativePath(rawKey);
                yield fullRelPath.slice(sublevelPrefix.length);
            }
        },

        async *listTargetKeys() {
            if (!await capabilities.checker.directoryExists(outputDir)) {
                return;
            }
            const allFiles = await walkFilesRecursively(capabilities, outputDir);
            for (const absPath of allFiles) {
                yield path.relative(outputDir, absPath).split(path.sep).join('/');
            }
        },

        async readSource(relPath) {
            const rawKey = require('../render/encoding').relativePathToKey(sublevelPrefix + relPath);
            const value = await rootDatabase._rawGet(rawKey);
            return serializeValue(value);
        },

        async readTarget(relPath) {
            const absPath = resolveContainedPath(outputDir, relPath);
            if (!await capabilities.checker.fileExists(absPath)) {
                return undefined;
            }
            return await capabilities.reader.readFileAsText(absPath);
        },

        equals(sv, tv) {
            return sv === tv;
        },

        async putTarget(relPath, content) {
            if (typeof content !== 'string') {
                throw new Error(
                    `db_to_fs putTarget: expected string content for "${relPath}", got ${typeof content}`
                );
            }
            const absPath = resolveContainedPath(outputDir, relPath);
            const file = await capabilities.creator.createFile(absPath);
            await capabilities.writer.writeFile(file, content);
        },

        async deleteTarget(relPath) {
            const absPath = resolveContainedPath(outputDir, relPath);
            await capabilities.deleter.deleteFile(absPath);
        },
    };
}

module.exports = {
    makeDbToFsAdapter,
};
