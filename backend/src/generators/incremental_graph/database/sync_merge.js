/**
 * Per-host graph merge algorithm for incremental-graph sync.
 *
 * This module implements the structured, LevelDB-level merge that replaces the
 * previous git-textual merge.  For each remote hostname, the algorithm:
 *
 *   1. Copies the active local replica L into the inactive replica T
 *      bit-identically (L and T become identical).
 *   2. Collects all nodes from T and H; computes initial per-node decisions
 *      from modification timestamps:
 *      - T-newer (or H absent) → 'keep'; if strictly newer, flag as force-keep root.
 *      - H-newer → 'take'; flag as force-take root.
 *      - Equal timestamps → 'keep'.
 *      Builds a merged dependency map using H.inputs for 'take' and H-only nodes,
 *      T.inputs for all others.
 *   3. Builds a stable topological ordering of the merged graph, which also
 *      detects cycles across the full merged structure (T + H-only additions +
 *      rewired edges from taken nodes).
 *   4. Propagates force-keep and force-take flags through the merged topological
 *      order using the merged inputs map, so each node inherits the taint of its
 *      most-upstream forced ancestor (even across rewired edges).
 *   5. Nodes tainted by both force-keep and force-take are 'invalidate'.
 *   6. H-only nodes are always 'take'; those with keepTainted ancestors get
 *      freshness overridden to `potentially-outdated`.
 *   7. Applies all decisions to T in one atomic batch, rebuilding the revdeps
 *      index from scratch.
 *   8. Switches the active replica pointer to T only when the merge produced
 *      graph changes; for pure no-op merges, keep the current replica.
 *
 * Error handling policy:
 * - Version mismatch throws HostVersionMismatchError.
 * - Graph cycles throw TopologicalSortCycleError (re-exported from topo_sort).
 * - All other errors propagate as-is to the caller.
 *
 * The caller (synchronize.js) is responsible for clearing the hostname staging
 * storage after each host merge completes (regardless of success/failure).
 *
 * Batching policy:
 * - We only chunk batch writes for entries whose values are potentially
 *   unbounded in size (e.g. node computation results stored in `values`).
 * - Keys and bounded-size metadata (freshness strings, timestamps, inputs
 *   records, revdeps key lists, counters) may be accumulated in RAM without
 *   chunking — their total size is proportional to the number of nodes, not
 *   the size of arbitrary computation output.
 */

const { isTopologicalSortCycleError } = require('./topo_sort');
const { stringToNodeIdentifier, versionToString } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');
const {
    makeEmptyIdentifierLookup,
    mergeIdentifierLookups,
    serializeIdentifierLookup,
} = require('./identifier_lookup');
const { buildMergePlan } = require('./sync_merge_plan');
const { unifyRevdeps } = require('./sync_merge_revdeps');
const { buildTakeOps, copyReplicaGently } = require('./sync_merge_transfer');
const {
    assertNoIdentifierLookupConflicts,
    parseIdentifierLookup,
} = require('./sync_merge_identifier_translation');

/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./root_database').ReplicaName} ReplicaName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').Version} Version */

/**
 * @typedef {import('../../../logger').Logger} Logger
 */

/**
 * Thrown when the remote hostname's stored `global/version` does not match the
 * local application version.  This means the two databases are at different
 * schema versions and cannot be safely merged.  Sync continues with the
 * remaining hostnames; only this host's merge is skipped.
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
 * Thrown when one or more per-host merges fail.  Contains per-host failure
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
 * Run the per-host graph merge algorithm for a single remote hostname.
 *
 * Pre-conditions (caller must ensure):
 * - The hostname's `r/` snapshot has been scanned into `hostnames/<hostname>`.
 * - The live database is locked for the duration of this call.
 *
 * Post-conditions (on success):
 * - The inactive replica contains the merged result.
 * - The active replica pointer is switched to the (previously inactive) replica.
 * - Hostname staging storage is NOT cleared here; the caller is responsible.
 *
 * @param {Logger} logger
 * @param {RootDatabase} rootDatabase
 * @param {string} hostname
 * @returns {Promise<boolean>} Whether the active replica pointer changed.
 * @throws {HostVersionMismatchError} If the remote's schema version differs from local.
 * @throws {import('./topo_sort').TopologicalSortCycleError} If the graph has a cycle.
 */
async function mergeHostIntoReplica(logger, rootDatabase, hostname) {
    // ── Step 0: Version check ────────────────────────────────────────────────
    const localVersionRaw = await rootDatabase.getGlobalVersion();
    const localVersion = localVersionRaw !== undefined ? versionToString(localVersionRaw) : undefined;
    const remoteVersionRaw = await rootDatabase.getHostnameGlobalVersion(hostname);
    const remoteVersion = remoteVersionRaw !== undefined ? versionToString(remoteVersionRaw) : undefined;

    if (localVersion !== remoteVersion) {
        throw new HostVersionMismatchError(
            hostname,
            localVersion ?? '(none)',
            remoteVersion ?? '(none)'
        );
    }

    const fromReplica = rootDatabase.currentReplicaName();
    const toReplica = rootDatabase.otherReplicaName();

    logger.logInfo(
        { hostname, fromReplica, toReplica },
        'Starting graph merge for host'
    );

    // ── Step 1: Gently copy L → T ────────────────────────────────────────────
    await copyReplicaGently(rootDatabase, fromReplica, toReplica);

    const T = rootDatabase.schemaStorageForReplica(toReplica);
    const H = rootDatabase.hostnameSchemaStorage(hostname);

    const hostLookup = parseIdentifierLookup(await H.global.get('identifiers_keys_map'));
    const targetRawLookup = await T.global.get('identifiers_keys_map');
    // Fresh local replicas may not have persisted lookup metadata yet.
    // Treat missing local target metadata as an empty lookup while keeping
    // strict parsing for host snapshots.
    const targetLookup = targetRawLookup === undefined
        ? makeEmptyIdentifierLookup()
        : parseIdentifierLookup(targetRawLookup);
    assertNoIdentifierLookupConflicts(targetLookup, hostLookup);

    /**
     * @param {NodeIdentifier} hostIdentifier
     * @returns {NodeIdentifier}
     */
    function targetIdentifierForHostIdentifier(hostIdentifier) {
        return hostIdentifier;
    }

    /**
     * @param {NodeIdentifier} targetIdentifier
     * @returns {NodeIdentifier}
     */
    function hostIdentifierForTargetIdentifier(targetIdentifier) {
        return targetIdentifier;
    }

    /**
     * @param {import('./root_database').InputsRecord | undefined} record
     * @returns {NodeIdentifier[]}
     */
    function translatedHostInputs(record) {
        return record
            ? record.inputs.map(input => targetIdentifierForHostIdentifier(stringToNodeIdentifier(input)))
            : [];
    }

    const {
        initialDecisions,
        mergedInputsMap,
        decisions,
        hOnlyNeedsInvalidate,
    } = await buildMergePlan(
        T,
        H,
        hostIdentifierForTargetIdentifier,
        translatedHostInputs
    );

    // ── Step 7: Apply decisions to T in chunks ──────────────────────────────
    /** @type {Array<*>} */
    let pendingOps = [];

    /**
     * Flush full chunks of `pendingOps` to T, leaving any partial chunk queued.
     * Uses a while loop so that pushing several ops at once (e.g. via
     * `pendingOps.push(...takeOps)`) never produces a batch larger than
     * RAW_BATCH_CHUNK_SIZE entries.
     * @returns {Promise<void>}
     */
    async function flushPendingOps() {
        while (pendingOps.length >= RAW_BATCH_CHUNK_SIZE) {
            await T.batch(pendingOps.slice(0, RAW_BATCH_CHUNK_SIZE));
            pendingOps = pendingOps.slice(RAW_BATCH_CHUNK_SIZE);
        }
    }

    for (const [node, decision] of decisions) {
        if (decision === 'take') {
            const takeOps = await buildTakeOps(T, H, node, hostIdentifierForTargetIdentifier(node), targetIdentifierForHostIdentifier);
            pendingOps.push(...takeOps);
            // H-only nodes whose ancestors include a locally-kept (T-newer) node
            // were computed on the remote with stale inputs.  Copy the structural
            // data from H so the node exists in T and the revdeps index is
            // correct, but override freshness to force recomputation.
            if (hOnlyNeedsInvalidate.has(node)) {
                pendingOps.push(T.freshness.putOp(node, 'potentially-outdated'));
            }
        } else if (decision === 'invalidate') {
            // If the node was initially 'take' (H newer) but got tainted to
            // 'invalidate', we must still apply H's structural state first
            // (inputs/counters/values/timestamps) so T stays consistent with
            // mergedInputsMap and rebuilt revdeps. We then force freshness to
            // potentially-outdated to trigger recomputation.
            if (initialDecisions.get(node) === 'take') {
                const takeOps = await buildTakeOps(T, H, node, hostIdentifierForTargetIdentifier(node), targetIdentifierForHostIdentifier);
                pendingOps.push(...takeOps);
            }
            pendingOps.push(T.freshness.putOp(node, 'potentially-outdated'));
            // Advance modifiedAt to H's value so the next sync does not see H as
            // newer and re-invalidate this node in an endless cycle.
            //
            // Background: without this fix, T.modifiedAt < H.modifiedAt still holds
            // after the merge, so compareIsoTimestamps keeps selecting the node as a
            // force-take candidate and the invalidate decision repeats on every sync
            // (even when local recomputation returns unchanged output and does not
            // bump the timestamp).
            //
            // This only applies when the initial decision was 'take' (H was strictly
            // newer).  For 'keep'-initial nodes that were tainted to 'invalidate' via
            // an ancestor, T.modifiedAt >= H.modifiedAt already — overwriting would
            // regress the timestamp.
            if (initialDecisions.get(node) === 'take') {
                const hTimestamps = await H.timestamps.get(hostIdentifierForTargetIdentifier(node));
                if (hTimestamps !== undefined) {
                    const tTimestamps = await T.timestamps.get(node);
                    // Preserve T's createdAt; advance only modifiedAt to H's value.
                    // tTimestamps can theoretically be undefined when the node was
                    // created before the timestamps feature was added (no record yet).
                    // In that case we fall back to H's createdAt as the best available
                    // approximation — the node exists in T (it was in T.inputs during
                    // step 2a) so it is not a truly new node.
                    const advanced = {
                        createdAt: tTimestamps?.createdAt ?? hTimestamps.createdAt,
                        modifiedAt: hTimestamps.modifiedAt,
                    };
                    pendingOps.push(T.timestamps.putOp(node, advanced));
                }
            }
        }
        // 'keep': no write operations needed; T already has the correct data.
        await flushPendingOps();
    }

    // Flush any remaining decisions ops before updating revdeps.
    if (pendingOps.length > 0) {
        await T.batch(pendingOps);
        pendingOps = [];
    }

    const decisionValues = [...decisions.values()];
    const kept = decisionValues.filter(d => d === 'keep').length, taken = decisionValues.filter(d => d === 'take').length, invalidated = decisionValues.filter(d => d === 'invalidate').length;
    const hasChanges = taken + invalidated > 0;

    if (hasChanges) {
        const mergedLookup = mergeIdentifierLookups(targetLookup, hostLookup);

        pendingOps.push(T.global.putOp('identifiers_keys_map', serializeIdentifierLookup(mergedLookup)));
        await flushPendingOps();
        await T.batch(pendingOps);
        pendingOps = [];

        // Gently update revdeps using the merged inputs map.  Only changed entries
        // are written; stale entries are deleted.  unifyRevdeps uses mergedInputsMap
        // directly, ensuring nodes that were initially 'take' (H.inputs) but
        // taint-propagated to 'invalidate' still use H.inputs for revdeps.
        await unifyRevdeps(T, mergedInputsMap);

        // ── Step 8: Persist active replica pointer ───────────────────────────
        await rootDatabase.setCurrentReplicaPointer(toReplica);
    }
    logger.logInfo(
        { hostname, fromReplica, toReplica, kept, taken, invalidated, switchedReplica: hasChanges },
        'Graph merge completed for host'
    );
    return hasChanges;
}

module.exports = {
    mergeHostIntoReplica,
    HostVersionMismatchError,
    isHostVersionMismatchError,
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
    isTopologicalSortCycleError,
};
