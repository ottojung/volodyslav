/**
 * Async preparation step for incremental graph storage lifecycle.
 *
 * `global/graph_scheme` is immutable replica initialization metadata, stored as a
 * string. It must be born together with `global/version`. Runtime graph construction
 * must never initialize, repair, backfill, or skip validation of durable graph
 * metadata.
 *
 * This function enforces the strict lifecycle:
 * - Uninitialized: both "version" and "graph_scheme" missing and the replica holds
 *   no structured graph/journal state → initialize both.
 * - Structured but unversioned: both "version" and "graph_scheme" missing while the
 *   replica already holds structured graph/journal state → throw clearly, because
 *   that state was produced outside the supported lifecycle transitions and must not
 *   be erased by re-initializing the replica as fresh.
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
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */

const {
    compileValidatedGraphSchema,
} = require("./graph_schema");
const {
    GRAPH_SCHEME_KEY,
    GraphSchemeError,
    MissingGraphSchemeError,
    assertExactStoredGraphSchemeMatches,
    initializeReplicaGlobals,
    assertValidReplicaMaterializationState,
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
 * Determine whether the active replica already holds structured graph/journal state.
 *
 * A genuinely fresh replica materializes nothing: its identifier lookup is empty and
 * its `values`, `freshness`, `timestamps`, `valid`, and `journal` sublevels hold no
 * entry. The global sublevel is deliberately not inspected because a fresh replica
 * persists `identifiers_keys_map`, `last_node_index`, and `fingerprint` there before
 * any version is written.
 *
 * Any materialized node, allocator mapping, or Journal record means the replica is an
 * existing database. Missing or malformed version/schema metadata over such state is
 * corruption, not absence, so it must never be erased by re-initializing the replica.
 *
 * @param {SchemaStorage} schemaStorage
 * @param {IdentifierLookup} identifierLookup
 * @returns {Promise<boolean>}
 */
async function replicaHoldsStructuredState(schemaStorage, identifierLookup) {
    if (identifierLookup.idToKey.size > 0) {
        return true;
    }
    const structuredSublevels = [
        schemaStorage.values,
        schemaStorage.freshness,
        schemaStorage.timestamps,
        schemaStorage.valid,
        schemaStorage.journal,
    ];
    for (const sublevel of structuredSublevels) {
        for await (const key of sublevel.keys()) {
            void key;
            return true;
        }
    }
    return false;
}

/**
 * Prepare incremental graph storage by validating persistent schema metadata and
 * compiling node definitions.
 *
 * Lifecycle logic:
 * - If both "version" and "graph_scheme" are missing and the replica holds no
 *   structured graph/journal state → genuinely fresh replica. Initializes both via
 *   initializeReplicaGlobals.
 * - If both "version" and "graph_scheme" are missing while the replica already holds
 *   structured graph/journal state → corrupted/unsupported state produced outside the
 *   supported lifecycle transitions; throws GraphSchemeError rather than erasing it.
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
    const prepared = compileValidatedGraphSchema(nodeDefs);
    const { compiledNodes, graphScheme, graphSchemeString, headIndex } = prepared;

    const schemaStorage = rootDatabase.getSchemaStorage();
    const storedVersion = await schemaStorage.global.get('version');
    const storedScheme = await schemaStorage.global.get(GRAPH_SCHEME_KEY);
    const currentVersion = rootDatabase.getVersion();

    if (storedVersion === undefined && storedScheme === undefined) {
        // Absence of version/schema metadata is fresh only when the replica is
        // genuinely empty. Structured state whose metadata is missing is corruption,
        // and re-initializing it as fresh would erase an existing database.
        if (await replicaHoldsStructuredState(schemaStorage, rootDatabase.getActiveIdentifierLookup())) {
            throw new GraphSchemeError(
                "Invalid graph storage: structured graph/journal state is present but both version " +
                "and graph_scheme are missing; refusing to re-initialize an existing replica as fresh"
            );
        }
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

    await assertValidReplicaMaterializationState(
        schemaStorage,
        rootDatabase.getActiveIdentifierLookup(),
        `active replica '${rootDatabase.currentReplicaName()}'`
    );

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
