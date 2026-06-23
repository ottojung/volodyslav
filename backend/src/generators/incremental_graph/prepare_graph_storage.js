/**
 * Async preparation step for incremental graph storage lifecycle.
 *
 * `global/graph_scheme` is immutable replica initialization metadata, stored as a
 * string. It must be born together with `global/version`. Runtime graph construction
 * must never initialize, repair, backfill, or skip validation of durable graph
 * metadata.
 *
 * This function enforces the strict lifecycle:
 * - Uninitialized: both "version" and "graph_scheme" missing → initialize both.
 * - Half-initialized: one present without the other → throw clearly.
 * - Initialized, matching version: exact string compare graph_scheme.
 * - Version mismatch: graph construction over a replica that needs migration is
 *   not allowed → throw clearly.
 *
 * The caller's responsibility is:
 *   1. Open the root database.
 *   2. Run migration (if needed).
 *   3. Call `prepareIncrementalGraphStorage()` to validate/initialize.
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
    GraphSchemeError,
    MissingGraphSchemeError,
    buildGraphSchemeFromNodeDefs,
    buildGraphSchemeStringFromNodeDefs,
    assertExactStoredGraphSchemeMatches,
    initializeReplicaGlobals,
} = require("./database");

/**
 * @typedef {object} PreparedGraphStorage
 * @property {RootDatabase} rootDatabase
 * @property {CompiledNode[]} compiledNodes
 * @property {GraphScheme} graphScheme
 * @property {Map<import('./types').NodeName, CompiledNode>} headIndex
 * @property {SchemaStorage} schemaStorage
 */

/**
 * Prepare incremental graph storage by validating persistent schema metadata and
 * compiling node definitions.
 *
 * Lifecycle logic:
 * - If both "version" and "graph_scheme" are missing → genuinely fresh replica.
 *   Initializes both via initializeReplicaGlobals.
 * - If "graph_scheme" exists but "version" is missing → half-initialized state,
 *   throws GraphSchemeError.
 * - If "version" exists but "graph_scheme" is missing → initialized replica
 *   without schema metadata, throws MissingGraphSchemeError.
 * - If both exist but version differs from current → migration needed, throws.
 * - If both exist and version matches → exact string comparison of graph_scheme
 *   via assertExactStoredGraphSchemeMatches.
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
    const currentVersion = rootDatabase.getVersion();

    if (storedVersion === undefined && storedScheme === undefined) {
        // Genuinely fresh active replica: initialize both together.
        await initializeReplicaGlobals(schemaStorage, {
            version: currentVersion,
            graphSchemeString,
        });
    } else if (storedVersion === undefined && storedScheme !== undefined) {
        throw new GraphSchemeError(
            "Invalid graph storage: graph_scheme exists but version is missing"
        );
    } else if (storedVersion !== undefined && storedScheme === undefined) {
        throw new MissingGraphSchemeError(
            `active replica '${rootDatabase.currentReplicaName()}'`
        );
    } else {
        // Both exist.
        if (storedVersion !== currentVersion) {
            throw new Error(
                `Cannot prepare incremental graph storage: active replica version ${String(storedVersion)} does not match current version ${String(currentVersion)}. Run migration before graph construction.`
            );
        }

        assertExactStoredGraphSchemeMatches(
            storedScheme,
            graphSchemeString,
            `active replica '${rootDatabase.currentReplicaName()}'`
        );
    }

    return {
        rootDatabase,
        compiledNodes,
        graphScheme,
        headIndex,
        schemaStorage,
    };
}

module.exports = {
    prepareIncrementalGraphStorage,
};
