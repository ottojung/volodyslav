/**
 * @file DB-to-paired-filesystem unification adapter.
 *
 * Replaces the old one-DB-value-to-one-JSON-file adapter with the exploded
 * JSON format. One DB value produces one kindtree schema file and zero or
 * more rendered primitive leaf files.
 *
 * Key space: internal virtual keys sorted by value root first.
 * See virtual_file_key.js for the key format.
 */

const path = require('path');
const { keyToRelativePath, relativePathToKey } = require('../../encoding');
const { projectExplodedJsonValue } = require('./value_codec');
const { flattenProjection, sortVirtualEntries } = require('./projection');
const { kindtreeVirtualKey, renderedVirtualKey, parseVirtualKey, virtualKeyToPhysicalPath } = require('./virtual_file_key');
const { preparePathForRegularFile, entryKind } = require('./filesystem_tree');

/** @typedef {import('../../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */

/**
 * @typedef {object} DbToPairedFsCapabilities
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {FileChecker} checker
 * @property {FileDeleter} deleter
 * @property {DirScanner} scanner
 */

/**
 * Resolve a relative path under baseDir and reject paths that escape it.
 *
 * @param {string} baseDir
 * @param {string} relPath
 * @returns {string}
 */
function resolveContainedPath(baseDir, relPath) {
    const resolvedBaseDir = path.resolve(baseDir);
    const resolvedPath = path.resolve(baseDir, relPath);
    const relativePath = path.relative(resolvedBaseDir, resolvedPath);
    if (relativePath === '' || relativePath.startsWith('..' + path.sep) || relativePath === '..') {
        throw new Error(
            `Invalid relative path '${relPath}': escapes the base directory`
        );
    }
    return resolvedPath;
}

/**
 * Recursively collect all file paths under a directory.
 *
 * @param {DbToPairedFsCapabilities} capabilities
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walkFilesRecursively(capabilities, dir) {
    const children = await capabilities.scanner.scanDirectory(dir);
    const files = [];
    for (const child of children) {
        if (await capabilities.checker.directoryExists(child.path)) {
            const nested = await walkFilesRecursively(capabilities, child.path);
            files.push(...nested);
        } else if (await capabilities.checker.fileExists(child.path)) {
            files.push(child.path);
        } else {
            // skip unsupported entries
        }
    }
    return files;
}

/**
 * Create a DB-to-paired-filesystem unification adapter.
 *
 * @param {DbToPairedFsCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {string} snapshotRoot - Absolute path to the snapshot root containing
 *   rendered/ and kindtree/.
 * @param {string} snapshotSublevel - The snapshot sublevel (e.g. "r").
 * @param {string} sourceSublevel - The DB sublevel to render from (e.g. "x").
 * @returns {import('./core').UnificationAdapter}
 */
function makeDbToPairedFsAdapter(capabilities, rootDatabase, snapshotRoot, snapshotSublevel, sourceSublevel) {
    const renderedRoot = path.join(snapshotRoot, 'rendered', snapshotSublevel);
    const kindtreeRoot = path.join(snapshotRoot, 'kindtree', snapshotSublevel);
    const rawKeyPrefix = '!' + sourceSublevel + '!';

    /**
     * Cache of value projections per value root.
     * Populated lazily by readSource, keyed by value root.
     * @type {Map<string, {schemaText: string, contentMap: Map<string, string>}>}
     */
    const projectionCache = new Map();

    /**
     * Load and project a DB value for a given value root.
     * @param {string} valueRoot
     * @returns {Promise<{schemaText: string, contentMap: Map<string, string>}>}
     */
    async function loadProjection(valueRoot) {
        const cached = projectionCache.get(valueRoot);
        if (cached) return cached;
        const rawKey = relativePathToKey(sourceSublevel + '/' + valueRoot);
        const innerKey = rawKey.slice(rawKeyPrefix.length);
        const dbValue = await rootDatabase._rawGetInSublevel(sourceSublevel, innerKey);
        if (dbValue === undefined) {
            throw new Error(`DB value not found for value root: ${valueRoot}`);
        }
        const projection = projectExplodedJsonValue(dbValue);
        const contentMap = new Map();
        for (const leaf of projection.leaves) {
            contentMap.set(leaf.descendantPath, leaf.content);
        }
        const entry = { schemaText: projection.schemaText, contentMap };
        projectionCache.set(valueRoot, entry);
        return entry;
    }

    return {
        async *listSourceKeys() {
            const relPaths = [];
            for await (const rawKey of rootDatabase._rawKeysForSublevel(sourceSublevel)) {
                const fullRelPath = keyToRelativePath(rawKey);
                const valueRoot = fullRelPath.slice(sourceSublevel.length + 1);
                relPaths.push(valueRoot);
            }
            relPaths.sort();
            for (const valueRoot of relPaths) {
                const projection = await loadProjection(valueRoot);
                // Emit kindtree key first, then rendered leaf keys
                yield kindtreeVirtualKey(valueRoot);
                for (const key of projection.contentMap.keys()) {
                    yield renderedVirtualKey(valueRoot, key);
                }
            }
        },

        async *listTargetKeys() {
            // Walk both kindtree/ and rendered/ under the snapshot sublevel
            const files = [];
            for (const rootDir of [kindtreeRoot, renderedRoot]) {
                if (await capabilities.checker.directoryExists(rootDir)) {
                    const absFiles = await walkFilesRecursively(capabilities, rootDir);
                    for (const absPath of absFiles) {
                        const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');
                        // Determine the tree from rootDir
                        const tree = rootDir === kindtreeRoot ? 'k' : 'r';
                        const parentRoot = rootDir === kindtreeRoot ? kindtreeRoot : renderedRoot;
                        const valueRootAndDesc = path.relative(parentRoot, absPath).split(path.sep).join('/');
                        // Find the value root (2 segments: sublevel + first dir)
                        // The structure is kindtree/<sublevel>/<valueRoot> or rendered/<sublevel>/<valueRoot>/<desc>
                        const segments = valueRootAndDesc.split('/');
                        if (segments.length === 0) continue;
                        if (tree === 'k') {
                            // kindtree/<sublevel>/<valueRoot>
                            const valueRoot = segments.join('/');
                            files.push(kindtreeVirtualKey(valueRoot));
                        } else {
                            // rendered/<sublevel>/<valueRoot>[/<desc>...]
                            const valueRoot = segments[0];
                            const descPath = segments.slice(1).join('/');
                            files.push(renderedVirtualKey(valueRoot, descPath || ''));
                        }
                    }
                }
            }
            files.sort();
            for (const vk of files) {
                yield vk;
            }
        },

        async readSource(virtualKey) {
            const parsed = parseVirtualKey(virtualKey);
            if (!parsed) {
                throw new Error(`Invalid virtual key: ${virtualKey}`);
            }
            const { valueRoot, tree, descendantPath } = parsed;
            const projection = await loadProjection(valueRoot);
            if (tree === 'k') {
                return projection.schemaText;
            }
            return projection.contentMap.get(descendantPath) || undefined;
        },

        async readTarget(virtualKey) {
            const parsed = parseVirtualKey(virtualKey);
            if (!parsed) {
                return undefined;
            }
            const relPath = virtualKeyToPhysicalPath(virtualKey, snapshotSublevel);
            const baseRoot = parsed.tree === 'k' ? kindtreeRoot : renderedRoot;
            const absPath = resolveContainedPath(
                parsed.tree === 'k' ? kindtreeRoot : renderedRoot,
                parsed.tree === 'k'
                    ? virtualKeyToPhysicalPath(virtualKey, snapshotSublevel).slice(`kindtree/${snapshotSublevel}/`.length)
                    : virtualKeyToPhysicalPath(virtualKey, snapshotSublevel).slice(`rendered/${snapshotSublevel}/`.length)
            );
            // Resolve properly
            const fullRel = virtualKeyToPhysicalPath(virtualKey, snapshotSublevel);
            const fullAbs = path.join(snapshotRoot, fullRel);
            if (!await capabilities.checker.fileExists(fullAbs)) {
                return undefined;
            }
            return await capabilities.reader.readFileAsText(fullAbs);
        },

        equals(sv, tv) {
            return sv === tv;
        },

        async putTarget(virtualKey, content) {
            if (typeof content !== 'string') {
                throw new Error(
                    `db_to_paired_fs putTarget: expected string content, got ${typeof content}`
                );
            }
            const fullRel = virtualKeyToPhysicalPath(virtualKey, snapshotSublevel);
            const absPath = path.join(snapshotRoot, fullRel);
            await preparePathForRegularFile(capabilities.creator, capabilities.checker, capabilities.deleter, absPath);
            const file = await capabilities.creator.createFile(absPath);
            await capabilities.writer.writeFile(file, content);
        },

        async deleteTarget(virtualKey) {
            const fullRel = virtualKeyToPhysicalPath(virtualKey, snapshotSublevel);
            const absPath = path.join(snapshotRoot, fullRel);
            if (await capabilities.checker.fileExists(absPath)) {
                await capabilities.deleter.deleteFile(absPath);
            }
        },
    };
}

module.exports = {
    makeDbToPairedFsAdapter,
};
