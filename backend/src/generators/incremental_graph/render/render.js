/**
 * Filesystem rendering module for the incremental-graph database.
 *
 * Provides renderToFilesystem(), which dumps every raw LevelDB key/value pair
 * to a directory tree.  Each key is mapped to a relative file path via
 * keyToRelativePath() (from encoding.js), and each value is serialised to a
 * JSON text file via serializeValue() (also from encoding.js).
 *
 * The inverse operation — reading the directory tree back into the database
 * — is provided by scanFromFilesystem() in scan.js.
 *
 * Path safety
 * -----------
 * resolveContainedPath() verifies that every path produced by
 * keyToRelativePath() resolves inside the output directory, preventing
 * directory-traversal writes.
 */

const path = require('path');
const { keyToRelativePath, serializeValue } = require('./encoding');

/** @typedef {import('../database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../logger').Logger} Logger */

/**
 * Capabilities required by renderToFilesystem.
 * @typedef {object} RenderCapabilities
 * @property {FileCreator} creator - Creates files (and parent directories) on disk.
 * @property {FileWriter} writer - Writes serialised content to an existing file.
 * @property {FileChecker} checker - Checks whether a path is a file or directory.
 * @property {FileDeleter} deleter - Deletes files or directories.
 * @property {Logger} logger - Logger for progress messages.
 */

const PARENT_DIRECTORY_PREFIX = '..' + path.sep;

/**
 * The input here is the result of path.relative() between two resolved paths,
 * so parent traversal can only appear as a leading `..` component.
 * @param {string} relativePath
 * @returns {boolean}
 */
function isParentTraversal(relativePath) {
    return relativePath === '..' || relativePath.startsWith(PARENT_DIRECTORY_PREFIX);
}

/**
 * Resolves a rendered relative path under a base directory and rejects paths
 * that would escape that directory.
 *
 * This check assumes `baseDir` itself is a trusted local directory with no
 * symlink-based escapes.
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
            `Invalid relative path '${relPath}': resolved path '${resolvedPath}' must point to a file within '${resolvedBaseDir}', not the directory itself`
        );
    }
    if (isParentTraversal(relativePath)) {
        throw new Error(
            `Invalid relative path '${relPath}': resolved path '${resolvedPath}' escapes the output directory '${resolvedBaseDir}'`
        );
    }
    return resolvedPath;
}

/**
 * Removes a previous rendered snapshot directory if it exists.
 * This prevents stale files from surviving across repeated renders into the
 * same output directory when the database shrinks between snapshots.
 *
 * @param {RenderCapabilities} capabilities
 * @param {string} outputDir
 * @returns {Promise<void>}
 */
async function clearRenderedSnapshot(capabilities, outputDir) {
    if (await capabilities.checker.directoryExists(outputDir)) {
        await capabilities.deleter.deleteDirectory(outputDir);
    }
}

/**
 * Dumps every raw key/value pair from a LevelDB database to a directory tree.
 *
 * For each entry in the database:
 *   - The key is mapped to a relative file path via keyToRelativePath().
 *   - The value is serialised and written to that file via serializeValue().
 *
 * Parent directories are created automatically.  The output directory itself
 * is also created if it does not already exist.
 *
 * This function is the inverse of scanFromFilesystem() in scan.js.
 *
 * @param {RenderCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to dump.
 * @param {string} outputDir - Absolute path of the directory to write into.
 * @returns {Promise<void>}
 */
async function renderToFilesystem(capabilities, rootDatabase, outputDir) {
    /** @type {Array<{ relPath: string, content: string }>} */
    const validatedEntries = [];
    for await (const [key, value] of rootDatabase._rawEntries()) {
        const relPath = keyToRelativePath(key);
        const content = serializeValue(value);
        validatedEntries.push({ relPath, content });
    }

    await clearRenderedSnapshot(capabilities, outputDir);
    for (const entry of validatedEntries) {
        const absPath = resolveContainedPath(outputDir, entry.relPath);
        const file = await capabilities.creator.createFile(absPath);
        await capabilities.writer.writeFile(file, entry.content);
    }
    capabilities.logger.logInfo(
        { outputDir, count: validatedEntries.length },
        'Rendered database to filesystem'
    );
}

module.exports = {
    renderToFilesystem,
};
