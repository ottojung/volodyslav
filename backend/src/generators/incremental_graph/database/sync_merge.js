/**
 * Per-host graph merge for incremental-graph synchronization.
 *
 * Synchronization stages each remote hostname into `hostnames/<hostname>` (the
 * host storage, `H`). This module merges that staged graph into the inactive
 * local replica (`T`) and, only when the merge changes graph data, makes `T` the
 * active replica. The currently-active local replica (`L`) is never modified by
 * this function.
 *
 * The merge is intentionally graph-aware rather than a textual/database-file
 * merge:
 *
 * 1. Verify that `H` was written by the same schema version as the local
 *    database.
 * 2. Copy `L` into `T`.
 * 3. Parse the target/host identifier lookups and reject only the corrupt case
 *    where one identifier names different semantic keys.
 * 4. Build a semantic-node-key merge plan from timestamps and dependencies. Newer
 *    local nodes are kept, newer host nodes are taken, and descendants of both a
 *    local-newer and host-newer ancestor are invalidated so they recompute from
 *    the merged inputs.
 * 5. Choose one final identifier per semantic key, lower all chosen inputs to
 *    those identifiers, apply the plan to `T`, and remove losing target records.
 * 6. Validate and persist the newly constructed lookup and
 *    switch replicas when graph data or identifier reconciliation changed.
 *
 * Error handling policy:
 * - Version mismatch throws HostVersionMismatchError.
 * - Identifier metadata conflicts/malformed records throw the specific errors
 *   defined by the identifier lookup modules.
 * - Graph cycles throw TopologicalSortCycleError from `topo_sort`.
 * - Unexpected storage failures propagate as-is to the caller.
 *
 * The caller (`synchronize.js`) owns hostname staging cleanup after this function
 * returns or throws.
 */

const { isTopologicalSortCycleError } = require('./topo_sort');
const { versionToString } = require('./types');
const {
    IDENTIFIERS_KEY,
    makeEmptyIdentifierLookup,
    serializeIdentifierLookup,
} = require('./identifier_lookup');
const { GRAPH_SCHEME_KEY } = require('./graph_scheme');
const { LAST_NODE_INDEX_KEY } = require('./root_database');
const { buildMergePlan } = require('./sync_merge_plan');
const {
    assertValidFinalMergeState,
    assertValidReplicaMaterializationState,
    FinalMergeStateError,
    isFinalMergeStateError,
} = require('./sync_merge_validation');
const { copyReplicaGently } = require('./sync_merge_transfer');
const { rebuildMergedValidity, buildValueOriginByKey, ReplicaBatchWriter } = require('./sync_merge_validity');
const { applyNodeDecisions, summarizeDecisions } = require('./sync_merge_apply');
const {
    assertNoIdentifierCollisions,
    parseIdentifierLookup,
} = require('./sync_merge_identifier_lookup');

/** @typedef {import('../../../logger').Logger} Logger */
/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./root_database').ReplicaName} ReplicaName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Version} Version */
/** @typedef {'keep' | 'take' | 'invalidate'} MergeDecision */

/**
 * Thrown when the staged host graph was produced by a different schema version
 * than the local database. A version mismatch is expected to be isolated to one
 * hostname: synchronization can skip this host and continue with others.
 */
class HostVersionMismatchError extends Error {
    /**
     * @param {string} hostname
     * @param {string} localVersion
     * @param {string} remoteVersion
     */
    constructor(hostname, localVersion, remoteVersion) {
        super(
            `Cannot merge host '${hostname}': version mismatch ` +
            `(local=${localVersion}, remote=${remoteVersion})`
        );
        this.name = 'HostVersionMismatchError';
        this.hostname = hostname;
        this.localVersion = localVersion;
        this.remoteVersion = remoteVersion;
    }
}

/**
 * @param {unknown} object
 * @returns {object is HostVersionMismatchError}
 */
function isHostVersionMismatchError(object) {
    return object instanceof HostVersionMismatchError;
}

/**
 * Thrown when one or more per-host merges fail. Contains per-host failure
 * records so callers can report exactly which hosts failed and which succeeded.
 */
class SyncMergeAggregateError extends Error {
    /**
     * @param {Array<{ hostname: string, message: string }>} failures
     */
    constructor(failures) {
        const lines = failures.map(f => `- ${f.hostname}: ${f.message}`).join('\n');
        super(`Failed to merge generators database branches:\n${lines}`);
        this.name = 'SyncMergeAggregateError';
        this.failures = failures;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SyncMergeAggregateError}
 */
function isSyncMergeAggregateError(object) {
    return object instanceof SyncMergeAggregateError;
}

/**
 * @param {Version | undefined} version
 * @returns {string | undefined}
 */
function formatOptionalVersion(version) {
    return version === undefined ? undefined : versionToString(version);
}

/**
 * @param {string | undefined} version
 * @returns {string}
 */
function formatVersionForError(version) {
    return version ?? '(none)';
}

/**
 * Verify that the staged host graph and local graph use the same schema version.
 *
 * @param {RootDatabase} rootDatabase
 * @param {string} hostname
 * @returns {Promise<void>}
 * @throws {HostVersionMismatchError}
 */
async function assertHostVersionMatches(rootDatabase, hostname) {
    const localVersion = formatOptionalVersion(await rootDatabase.getGlobalVersion());
    const remoteVersion = formatOptionalVersion(await rootDatabase.getHostnameGlobalVersion(hostname));

    if (localVersion !== remoteVersion) {
        throw new HostVersionMismatchError(
            hostname,
            formatVersionForError(localVersion),
            formatVersionForError(remoteVersion)
        );
    }
}

/**
 * Load and validate the merge target's identifier lookup.
 * Returns an empty lookup when the target is a genuinely fresh replica (no
 * version either).  Missing metadata on a replica that already has a version
 * is a hard error.
 *
 * @param {SchemaStorage} targetStorage
 * @returns {Promise<IdentifierLookup>}
 */
async function loadTargetLookup(targetStorage) {
    const targetRawLookup = await targetStorage.global.get(IDENTIFIERS_KEY);
    const targetVersion = await targetStorage.global.get('version');
    return targetRawLookup === undefined && targetVersion === undefined
        ? makeEmptyIdentifierLookup()
        : parseIdentifierLookup(targetRawLookup, 'merge target replica');
}

/**
 * Persist the final semantic-plan lookup and commit the inactive replica as active.
 *
 * `targetLastNodeIndex` is local allocation metadata for the local fingerprint
 * namespace. Normal sync merge may import host identifiers (e.g. `42-HOSTFP`),
 * but those carry a different fingerprint, so they do not advance the local
 * allocator watermark for `LOCALFP`. The local allocator only issues identifiers
 * with the local database fingerprint. Same-fingerprint staged host snapshots are
 * not part of the normal supported sync-merge case — they would correspond to
 * unsupported cross-host snapshot cloning, or to an own-host snapshot path that
 * should not go through normal per-host merge. Therefore the target's
 * `last_node_index` is intentionally preserved unchanged.
 *
 * @param {RootDatabase} rootDatabase
 * @param {SchemaStorage} targetStorage
 * @param {ReplicaName} targetReplica
 * @param {IdentifierLookup} finalIdentifierLookup
 * @param {number} targetLastNodeIndex - Preserved local allocation watermark.
 * @returns {Promise<void>}
 */
async function commitChangedMerge(
    rootDatabase, targetStorage, targetReplica,
    finalIdentifierLookup, targetLastNodeIndex
) {
    const writer = new ReplicaBatchWriter(targetStorage);
    await writer.push(targetStorage.global.putOp(
        IDENTIFIERS_KEY,
        serializeIdentifierLookup(finalIdentifierLookup)
    ));
    // Commit the unchanged local allocation watermark.
    // Imported host identifiers use distinct fingerprints so they never consume
    // local index space. See JSDoc above for the full invariant.
    await writer.push(targetStorage.global.putOp(LAST_NODE_INDEX_KEY, targetLastNodeIndex));
    await writer.flush();
    await rootDatabase.setCurrentReplicaPointer(targetReplica);
}


/**
 * Run the graph-aware merge algorithm for one staged remote hostname.
 *
 * Pre-conditions:
 * - The hostname's remote snapshot has already been scanned into hostname
 *   staging storage.
 * - The live database is locked for the duration of this call.
 *
 * Post-conditions on success:
 * - If the merge changed graph data, reconciled identifiers, or imported new
 *   validity metadata, the inactive replica contains the merged graph and is
 *   made active.
 * - If every node, identifier, and validity relation was kept, the active
 *   replica pointer is unchanged. The inactive replica may still have been
 *   refreshed as a copy of the active replica, but callers must continue
 *   reading from the active pointer.
 * - Hostname staging storage is not cleared here; the caller owns cleanup.
 *
 * @param {Logger} logger
 * @param {RootDatabase} rootDatabase
 * @param {string} hostname
 * @returns {Promise<boolean>} Whether the active replica pointer changed.
 * @throws {HostVersionMismatchError} If the remote schema version differs from local.
 * @throws {import('./topo_sort').TopologicalSortCycleError} If the merged graph has a cycle.
 */
async function mergeHostIntoReplica(logger, rootDatabase, hostname) {
    await assertHostVersionMatches(rootDatabase, hostname);

    // Fail-fast: validate host metadata before expensive copy.
    const hostStorage = rootDatabase.hostnameSchemaStorage(hostname);
    const hostLookup = parseIdentifierLookup(
        await hostStorage.global.get(IDENTIFIERS_KEY),
        'staged host snapshot'
    );

    const fromReplica = rootDatabase.currentReplicaName();
    const toReplica = rootDatabase.otherReplicaName();

    logger.logInfo(
        { hostname, fromReplica, toReplica },
        'Starting graph merge for host'
    );

    await assertValidReplicaMaterializationState(hostStorage, hostLookup, 'staged host snapshot');

    await copyReplicaGently(rootDatabase, fromReplica, toReplica);

    const targetStorage = rootDatabase.schemaStorageForReplica(toReplica);
    const targetLookup = await loadTargetLookup(targetStorage);
    assertNoIdentifierCollisions(targetLookup, hostLookup);
    await assertValidReplicaMaterializationState(targetStorage, targetLookup, 'local synchronization source');

    const targetSchemeRaw = await targetStorage.global.get(GRAPH_SCHEME_KEY);
    const hostSchemeRaw = await hostStorage.global.get(GRAPH_SCHEME_KEY);

    if (typeof targetSchemeRaw !== "string") throw new Error(
        `Cannot merge host '${hostname}': target replica is missing a string graph_scheme`);
    if (typeof hostSchemeRaw !== "string") throw new Error(
        `Cannot merge host '${hostname}': staged host snapshot is missing a string graph_scheme`);
    if (targetSchemeRaw !== hostSchemeRaw) throw new Error(
        `Cannot merge host '${hostname}': same version but different graph_scheme ` +
        `(exact string comparison failed)`);

    // Capture the local allocation watermark before merge. This value is
    // local fingerprint namespace metadata — host identifiers with different
    // fingerprints do not advance it. It is committed unchanged in
    // commitChangedMerge (see that function's JSDoc for the full invariant).
    const targetLastNodeIndex = rootDatabase.getLastNodeIndex();

    const {
        initialDecisions,
        mergedInputsMap,
        decisions,
        hardInvalidationKeys,
        finalIdentifierForKey,
        finalIdentifierLookup,
        hasIdentifierReconciliation,
    } = await buildMergePlan(
        targetStorage,
        hostStorage,
        targetLookup,
        hostLookup
    );

    await applyNodeDecisions(
        targetStorage,
        hostStorage,
        targetLookup,
        hostLookup,
        initialDecisions,
        decisions,
        hardInvalidationKeys,
        finalIdentifierForKey
    );

    const summary = summarizeDecisions(decisions.entries(), targetLookup);
    const hasSemanticChanges = summary.hasChanges || hasIdentifierReconciliation;
    const targetSourceStorage = rootDatabase.schemaStorageForReplica(fromReplica);
    const valueOriginByKey = await buildValueOriginByKey(
        initialDecisions,
        decisions,
        targetLookup,
        hostLookup,
        finalIdentifierForKey
    );

    /** @type {Set<NodeIdentifier>} */
    const directInvalidationRoots = new Set();
    for (const nodeKey of decisions.keys()) {
        if (!hardInvalidationKeys.has(nodeKey)) continue;
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId !== undefined) {
            directInvalidationRoots.add(finalId);
        }
    }

    const graphStateChanged = await rebuildMergedValidity({
        targetStorage,
        targetSourceStorage,
        hostSourceStorage: hostStorage,
        targetLookup,
        hostLookup,
        finalIdentifierForKey,
        mergedInputsMap,
        valueOriginByKey,
        directInvalidationRoots,
    });
    const hasChanges = hasSemanticChanges || graphStateChanged;
    await assertValidFinalMergeState(targetStorage, finalIdentifierLookup);

    if (hasChanges) {
        await commitChangedMerge(
            rootDatabase,
            targetStorage,
            toReplica,
            finalIdentifierLookup,
            targetLastNodeIndex
        );
    }

    const switchedReplica = hasChanges;
    logger.logInfo(
        {
            hostname,
            fromReplica,
            toReplica,
            kept: summary.kept,
            taken: summary.taken,
            invalidated: summary.invalidated,
            deleted: summary.deleted,
            switchedReplica,
        },
        'Graph merge completed for host'
    );
    return switchedReplica;
}

module.exports = {
    mergeHostIntoReplica,
    HostVersionMismatchError,
    isHostVersionMismatchError,
    FinalMergeStateError,
    isFinalMergeStateError,
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
    isTopologicalSortCycleError,
};
