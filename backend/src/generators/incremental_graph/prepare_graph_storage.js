/**
 * Async preparation step for incremental graph storage lifecycle.
 *
 * This module provides `prepareIncrementalGraphStorage()` which runs all async
 * storage lifecycle that used to be inside the IncrementalGraphClass constructor.
 *
 * The caller's responsibility is:
 *   1. Open the root database.
 *   2. Run migration (if needed).
 *   3. Call `prepareIncrementalGraphStorage()` to validate/initialize
 *      persistent schema metadata and compile the node definitions.
 *   4. Construct IncrementalGraphClass with the prepared state.
 *
 * After construction the graph is immediately usable — no hidden async promises.
 */

/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./database/graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */

const {
    compileNodeDef,
    validateAcyclic,
    validateInputArities,
    validateNoOverlap,
    validateSingleArityPerHead,
} = require("./compiled_node");
const {
    GRAPH_SCHEME_KEY,
    buildGraphSchemeFromNodeDefs,
    buildGraphSchemeStringFromNodeDefs,
    assertExactStoredGraphSchemeMatches,
    versionToString,
} = require("./database");

/**
 * @typedef {object} PreparedGraphStorage
 * @property {RootDatabase} rootDatabase
 * @property {CompiledNode[]} compiledNodes
 * @property {GraphScheme} graphScheme
 * @property {string} graphSchemeString
 * @property {Map<import('./types').NodeName, CompiledNode>} headIndex
 */

/**
 * Prepare incremental graph storage by validating persistent schema metadata and
 * compiling node definitions.
 *
 * This function:
 * - Compiles node definitions and validates the pure schema (no async).
 * - Builds the current graph scheme string from compiled nodes.
 * - Reads the stored global/version and global/graph_scheme.
 * - For a genuinely fresh database (no stored version and no stored scheme):
 *   writes global/version and global/graph_scheme together as one batch.
 * - For an initialized database with matching version: validates that the stored
 *   graph_scheme matches the current scheme exactly (raw string comparison).
 * - For an initialized database with a different version (pre-migration): allows
 *   the stored scheme to differ — the migration runner has already or will write
 *   the new scheme as part of the migration process.
 * - For a versioned database with no stored graph_scheme: throws
 *   MissingGraphSchemeError (corruption).
 *
 * @param {RootDatabase} rootDatabase
 * @param {Array<NodeDef>} nodeDefs
 * @returns {Promise<PreparedGraphStorage>}
 */
async function prepareIncrementalGraphStorage(rootDatabase, nodeDefs) {
    const compiledNodes = nodeDefs.map(compileNodeDef);
    validateNoOverlap(compiledNodes);
    validateAcyclic(compiledNodes);
    validateSingleArityPerHead(compiledNodes);
    validateInputArities(compiledNodes);

    const graphScheme = buildGraphSchemeFromNodeDefs(compiledNodes);
    const graphSchemeString = buildGraphSchemeStringFromNodeDefs(compiledNodes);

    /** @type {Map<import('./types').NodeName, CompiledNode>} */
    const headIndex = new Map();
    for (const compiledNode of compiledNodes) {
        headIndex.set(compiledNode.head, compiledNode);
    }

    const schemaStorage = rootDatabase.getSchemaStorage();
    const storedVersion = await schemaStorage.global.get('version');
    const storedScheme = await schemaStorage.global.get(GRAPH_SCHEME_KEY);

    if (storedVersion === undefined) {
        if (storedScheme === undefined) {
            // Genuinely fresh database: write version and graph_scheme
            // together as one logical initialization operation.
            const currentVersion = rootDatabase.getVersion();
            /** @type {Array<*>} */
            const initOps = [
                schemaStorage.global.putOp('version', versionToString(currentVersion)),
                schemaStorage.global.putOp(GRAPH_SCHEME_KEY, graphSchemeString),
            ];
            await schemaStorage.batch(initOps);
        }
        // If storedScheme exists but version doesn't, proceed without validation.
        // This state should not normally occur and may be handled by migration.
    } else {
        // Versioned database: validate stored graph_scheme.
        const currentVersion = rootDatabase.getVersion();
        if (storedVersion === currentVersion) {
            assertExactStoredGraphSchemeMatches(
                storedScheme,
                graphSchemeString,
                `active replica '${rootDatabase.currentReplicaName()}'`
            );
        }
        // If stored version differs from current version, migration owns writing
        // the new scheme.  No validation needed here.
    }

    return {
        rootDatabase,
        compiledNodes,
        graphScheme,
        graphSchemeString,
        headIndex,
    };
}

module.exports = {
    prepareIncrementalGraphStorage,
};
