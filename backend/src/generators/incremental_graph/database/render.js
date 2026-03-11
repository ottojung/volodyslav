/**
 * Filesystem rendering module for the incremental-graph database.
 *
 * Provides two complementary operations that form a bijective pair:
 *
 *   renderToFilesystem(capabilities, rootDatabase, outputDir)
 *     Dumps every raw LevelDB key/value pair to a directory tree.
 *     Each key is mapped to a relative file path via keyToRelativePath().
 *     Each value is written as a JSON string.
 *
 *   scanFromFilesystem(capabilities, rootDatabase, inputDir)
 *     Restores a database from a directory tree written by renderToFilesystem().
 *     Walks inputDir recursively, maps each file path back to a key via
 *     relativePathToKey(), parses the JSON content, and writes the entry
 *     directly into the LevelDB root instance.
 *
 * Key encoding
 * ------------
 * LevelDB sublevel keys use '!' as the namespace separator. A key stored two
 * levels deep looks like:
 *
 *   !namespace!!sublevel!{"head":"all_events","args":[]}
 *
 * keyToRelativePath() converts this to a relative path:
 *
 *   namespace/sublevel/{"head":"all_events","args":[]}
 *
 * Any '/' characters that appear inside the key itself (e.g. in file-path
 * arguments such as '{"head":"transcription","args":["/audio/x.mp3"]}') are
 * first percent-encoded as '%2F' so they do not become unintended directory
 * separators.  Likewise '%' is pre-encoded as '%25' to maintain injectivity.
 *
 * relativePathToKey() is the exact inverse: it decodes '%2F' back to '/' and
 * '%25' back to '%', then reassembles the LevelDB key.
 *
 * The mapping is bijective for all keys created by the abstract-level sublevel
 * API (where sublevel names and actual keys do not contain the '!' separator).
 */

const path = require('path');
const { nodeKeyStringToString } = require('./types');

/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../logger').Logger} Logger */

/**
 * Capabilities required by renderToFilesystem and scanFromFilesystem.
 * @typedef {object} RenderCapabilities
 * @property {FileCreator} creator - Creates files (and parent directories) on disk.
 * @property {FileWriter} writer - Writes string content to an existing file.
 * @property {FileReader} reader - Reads file content as a UTF-8 string.
 * @property {FileChecker} checker - Checks whether a path is a file or directory.
 * @property {DirScanner} scanner - Scans directory contents (non-recursive).
 * @property {Logger} logger - Logger for progress messages.
 */

/**
 * Converts a raw LevelDB key to a relative filesystem path.
 *
 * Steps:
 *   1. Percent-encode '%' as '%25' and '/' as '%2F' to prevent key-internal
 *      slashes from creating unintended directory levels.
 *   2. Split the encoded key on '!', filter out empty segments (which arise
 *      from the leading '!' and the sublevel-nesting '!!'), then join the
 *      remaining segments with '/'.
 *
 * Examples:
 *   '!_meta!format'                      → '_meta/format'
 *   '!x!!values!{"head":"all_events"...}'→ 'x/values/{"head":"all_events"...}'
 *   '!x!!values!{"head":"t","args":["/a"]}' → 'x/values/{"head":"t","args":["%2Fa"]}'
 *
 * @param {string} key - Raw LevelDB key.
 * @returns {string} Relative filesystem path.
 */
function keyToRelativePath(key) {
    const escaped = key.replace(/%/g, '%25').replace(/\//g, '%2F');
    return escaped.split('!').filter(s => s !== '').join('/');
}

/**
 * Converts a relative filesystem path back to a raw LevelDB key.
 * This is the exact inverse of keyToRelativePath().
 *
 * Steps:
 *   1. Split the path on '/'.
 *   2. Decode '%2F' → '/' and '%25' → '%' in every segment.
 *   3. Reassemble using the LevelDB sublevel key format:
 *        '!' + sublevels.join('!!') + '!' + actualKey
 *      where all segments except the last are sublevel names and the last
 *      segment is the actual stored key.
 *
 * Requires at least two path segments (one sublevel + one key).
 *
 * @param {string} relPath - Relative path from keyToRelativePath().
 * @returns {string} Raw LevelDB key.
 * @throws {Error} If relPath has fewer than two segments.
 */
function relativePathToKey(relPath) {
    const rawParts = relPath.split('/');
    if (rawParts.length < 2) {
        throw new Error(
            `Invalid database path '${relPath}': expected at least two segments (sublevel + key).`
        );
    }
    const decodedParts = rawParts.map(p =>
        p.replace(/%2F/gi, '/').replace(/%25/gi, '%')
    );
    const sublevels = decodedParts.slice(0, -1);
    const actualKey = decodedParts[decodedParts.length - 1];
    return '!' + sublevels.join('!!') + '!' + actualKey;
}

/**
 * Recursively collects the absolute paths of every regular file under `dir`
 * using the capabilities pattern.
 * Directories are traversed but not included in the result.
 *
 * @param {RenderCapabilities} capabilities
 * @param {string} dir - Root directory to walk.
 * @returns {Promise<string[]>} Absolute paths of all files found.
 */
async function walkFilesRecursively(capabilities, dir) {
    const children = await capabilities.scanner.scanDirectory(dir);
    const files = [];
    for (const child of children) {
        if (await capabilities.checker.directoryExists(child.path)) {
            const nested = await walkFilesRecursively(capabilities, child.path);
            files.push(...nested);
        } else {
            files.push(child.path);
        }
    }
    return files;
}

/**
 * Dumps every raw key/value pair from a LevelDB database to a directory tree.
 *
 * For each entry in the database:
 *   - The key is mapped to a relative file path via keyToRelativePath().
 *   - The value is JSON-serialised and written to that file.
 *
 * Parent directories are created automatically.  The output directory itself
 * is also created if it does not already exist.
 *
 * This function is the inverse of scanFromFilesystem().
 *
 * @param {RenderCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to dump.
 * @param {string} outputDir - Absolute path of the directory to write into.
 * @returns {Promise<void>}
 */
async function renderToFilesystem(capabilities, rootDatabase, outputDir) {
    let count = 0;
    for await (const [key, value] of rootDatabase._rawEntries()) {
        const relPath = keyToRelativePath(nodeKeyStringToString(key));
        const absPath = path.join(outputDir, relPath);
        const file = await capabilities.creator.createFile(absPath);
        await capabilities.writer.writeFile(file, JSON.stringify(value));
        count++;
    }
    capabilities.logger.logInfo(
        { outputDir, count },
        'Rendered database to filesystem'
    );
}

/**
 * Reads every file from a directory tree and writes the corresponding
 * key/value pairs into a LevelDB database.
 *
 * For each file found under `inputDir`:
 *   - The path relative to `inputDir` is converted back to a raw LevelDB
 *     key via relativePathToKey().
 *   - The file content is parsed as JSON and stored at that key.
 *
 * Calling scanFromFilesystem() on a directory produced by renderToFilesystem()
 * restores the database to exactly its original state (bijection guarantee).
 *
 * @param {RenderCapabilities} capabilities
 * @param {RootDatabase} rootDatabase - The database to populate.
 * @param {string} inputDir - Absolute path of the directory to read from.
 * @returns {Promise<void>}
 */
async function scanFromFilesystem(capabilities, rootDatabase, inputDir) {
    const allFiles = await walkFilesRecursively(capabilities, inputDir);
    let count = 0;
    for (const absPath of allFiles) {
        const relPath = path.relative(inputDir, absPath);
        const normalizedRelPath = relPath.split(path.sep).join('/');
        const key = relativePathToKey(normalizedRelPath);
        const content = await capabilities.reader.readFileAsText(absPath);
        const value = JSON.parse(content);
        await rootDatabase._rawPut(key, value);
        count++;
    }
    capabilities.logger.logInfo(
        { inputDir, count },
        'Scanned database from filesystem'
    );
}

module.exports = {
    renderToFilesystem,
    scanFromFilesystem,
    keyToRelativePath,
    relativePathToKey,
};
