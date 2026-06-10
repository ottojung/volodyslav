/**
 * @file Paired-filesystem-to-DB unification adapter.
 *
 * Scans a paired snapshot (kindtree/ + rendered/) and reconstructs complete
 * DB values. Uses unifyStores() to reconcile into the target DB sublevel.
 *
 * The adapter produces raw DB keys as the key space. For each schema file
 * in kindtree/, it decodes the value root, maps it to a raw DB key, then
 * reads the schema and scans the corresponding rendered leaves to reconstruct
 * the complete DB value.
 *
 * kindtree is the source of DB value roots. A rendered file without a
 * claiming schema is invalid.
 */

const path = require('path');
const { relativePathToKey } = require('../../encoding');
const { parseSchema } = require('./schema_codec');
const { scanExplodedJsonProjection } = require('./value_codec');
const { jsonStructuralEquals } = require('./value_equality');
const {
    MissingKindtreeRootError,
    ExtraRenderedFileError,
    DuplicateDecodedValueRootError,
    MissingRenderedLeafError,
    RenderedDirectoryWhereFileRequiredError,
} = require('./errors');

/** @typedef {import('../../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../../filesystem/dirscanner').DirScanner} DirScanner */

/**
 * @typedef {object} PairedFsToDbCapabilities
 * @property {FileReader} reader
 * @property {FileChecker} checker
 * @property {DirScanner} scanner
 */

/**
 * Recursively collect all file paths under a directory.
 * @param {PairedFsToDbCapabilities} capabilities
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
        }
    }
    return files;
}

/**
 * Build a trie of the rendered filesystem tree for scan validation.
 * Returns a map from logical path to entry kind.
 *
 * @param {PairedFsToDbCapabilities} capabilities
 * @param {string} renderedDir - The rendered/<sublevel> directory.
 * @returns {Promise<Map<string, "file"|"directory">>}
 */
async function buildRenderedTree(capabilities, renderedDir) {
    const tree = new Map();
    if (!await capabilities.checker.directoryExists(renderedDir)) {
        return tree;
    }
    const allFiles = await walkFilesRecursively(capabilities, renderedDir);
    for (const absPath of allFiles) {
        const relPath = path.relative(renderedDir, absPath).split(path.sep).join('/');
        tree.set(relPath, "file");
    }
    // Add directories as needed for traversal validation
    const dirs = new Set();
    for (const relPath of tree.keys()) {
        const segments = relPath.split('/');
        for (let i = 1; i < segments.length; i++) {
            dirs.add(segments.slice(0, i).join('/'));
        }
    }
    for (const dirPath of dirs) {
        if (!tree.has(dirPath)) {
            tree.set(dirPath, "directory");
        }
    }
    return tree;
}

/**
 * Create a paired filesystem-to-DB unification adapter.
 *
 * @param {PairedFsToDbCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {string} snapshotRoot - Absolute path to the snapshot root.
 * @param {string} snapshotSublevel - The snapshot sublevel (e.g. "r").
 * @param {string} targetSublevel - The target DB sublevel (e.g. "y").
 * @returns {import('../../unification/core').UnificationAdapter}
 */
function makePairedFsToDbAdapter(capabilities, rootDatabase, snapshotRoot, snapshotSublevel, targetSublevel) {
    const kindtreeDir = path.join(snapshotRoot, 'kindtree', snapshotSublevel);
    const renderedDir = path.join(snapshotRoot, 'rendered', snapshotSublevel);

    /**
     * Cache: for each value root, the reconstructed DB value (or undefined if
     * the kindtree root is missing).
     * @type {Map<string, unknown>}
     */
    const valueCache = new Map();

    /**
     * Set of claimed rendered leaf paths (relative to rendered/<sublevel>/<valueRoot>).
     * @type {Set<string>}
     */
    const claimedLeaves = new Set();

    /**
     * Set of value roots that have been processed.
     * @type {Set<string>}
     */
    const processedRoots = new Set();

    /**
     * The rendered tree (all files and directories under rendered/<sublevel>).
     * @type {Promise<Map<string, "file"|"directory">> | null}
     */
    let renderedTreePromise = null;

    /**
     * Reconstruct a DB value from its kindtree schema and rendered leaves.
     * @param {string} valueRoot
     * @returns {Promise<unknown>}
     */
    async function reconstructValue(valueRoot) {
        const kindtreePath = path.join(kindtreeDir, valueRoot);
        if (!await capabilities.checker.fileExists(kindtreePath)) {
            throw new MissingKindtreeRootError(valueRoot);
        }
        const schemaText = await capabilities.reader.readFileAsText(kindtreePath);
        const schema = parseSchema(schemaText);
        const tree = await renderedTreePromise;
        if (tree === null) throw new Error('No rendered tree available');
        return scanExplodedJsonProjection(schema, async (descendantPath) => {
            const leafRelPath = descendantPath ? `${valueRoot}/${descendantPath}` : valueRoot;
            const entry = tree.get(leafRelPath);
            if (entry === "directory") {
                throw new RenderedDirectoryWhereFileRequiredError(valueRoot, descendantPath);
            }
            if (entry !== "file") {
                throw new MissingRenderedLeafError(valueRoot, descendantPath, "unknown");
            }
            claimedLeaves.add(leafRelPath);
            const absPath = descendantPath
                ? path.join(renderedDir, valueRoot, descendantPath)
                : path.join(renderedDir, valueRoot);
            return capabilities.reader.readFileAsText(absPath);
        });
    }

    /**
     * Decode a value root to a raw DB key.
     * @param {string} valueRoot
     * @returns {string}
     */
    function valueRootToRawKey(valueRoot) {
        return relativePathToKey(targetSublevel + '/' + valueRoot);
    }

    /**
     * Map from raw DB key to value root.
     * @type {Map<string, string>}
     */
    const rawKeyToValueRoot = new Map();

    return {
        async *listSourceKeys() {
            // Build rendered tree lazily
            renderedTreePromise = buildRenderedTree(capabilities, renderedDir);
            const tree = await renderedTreePromise;

            // Enumerate all kindtree schema files
            const kindtreeFiles = [];
            if (await capabilities.checker.directoryExists(kindtreeDir)) {
                const absFiles = await walkFilesRecursively(capabilities, kindtreeDir);
                for (const absPath of absFiles) {
                    const relPath = path.relative(kindtreeDir, absPath).split(path.sep).join('/');
                    kindtreeFiles.push(relPath);
                }
            }
            kindtreeFiles.sort();

            for (const valueRoot of kindtreeFiles) {
                const rawKey = valueRootToRawKey(valueRoot);
                // Check for duplicate decoded raw keys
                if (rawKeyToValueRoot.has(rawKey)) {
                    const existingRoot = rawKeyToValueRoot.get(rawKey);
                    throw new DuplicateDecodedValueRootError(
                        existingRoot ?? '', valueRoot, rawKey
                    );
                }
                rawKeyToValueRoot.set(rawKey, valueRoot);
            }

            // Validate: all kindtree files are now mapped to raw keys.
            // Reconstruct values and yield raw keys.
            for (const valueRoot of kindtreeFiles) {
                const rawKey = valueRootToRawKey(valueRoot);
                const value = await reconstructValue(valueRoot);
                valueCache.set(valueRoot, value);
                processedRoots.add(valueRoot);
                yield rawKey;
            }

            // After all schemas, check for unclaimed rendered files
            for (const [relPath, kind] of tree) {
                if (kind === "file" && !claimedLeaves.has(relPath)) {
                    const segments = relPath.split('/');
                    const vr = segments[0] ?? '';
                    const leafPath = segments.slice(1).join('/');
                    throw new ExtraRenderedFileError(vr, leafPath);
                }
            }
        },

        async *listTargetKeys() {
            for await (const rawKey of rootDatabase._rawKeysForSublevel(targetSublevel)) {
                yield rawKey;
            }
        },

        /**
         * @param {string} rawKey
         * @returns {Promise<unknown>}
         */
        async readSource(rawKey) {
            const valueRoot = rawKeyToValueRoot.get(rawKey);
            if (!valueRoot) return undefined;
            return valueCache.get(valueRoot);
        },

        /**
         * @param {string} rawKey
         * @returns {Promise<unknown>}
         */
        async readTarget(rawKey) {
            const innerKey = rawKey.slice(('!' + targetSublevel + '!').length);
            return await rootDatabase._rawGetInSublevel(targetSublevel, innerKey);
        },

        /**
         * @param {unknown} sv
         * @param {unknown} tv
         * @returns {boolean}
         */
        equals(sv, tv) {
            return jsonStructuralEquals(sv, tv);
        },

        /**
         * @param {string} rawKey
         * @param {unknown} value
         * @returns {Promise<void>}
         */
        async putTarget(rawKey, value) {
            await rootDatabase._rawPut(rawKey, value);
        },

        /**
         * @param {string} rawKey
         * @returns {Promise<void>}
         */
        async deleteTarget(rawKey) {
            await rootDatabase._rawDel(rawKey);
        },

        async flush() {
            await rootDatabase._rawSync();
        },
    };
}

module.exports = {
    makePairedFsToDbAdapter,
};
