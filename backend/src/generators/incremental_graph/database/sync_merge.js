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
 *   8. Switches the active replica pointer to T.
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

const { topologicalSortFromMap, isTopologicalSortCycleError } = require('./topo_sort');
const { stringToNodeKeyString, versionToString } = require('./types');
const { compareNodeKeyStringByNodeKey } = require('./node_key');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');

/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./root_database').ReplicaName} ReplicaName */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Version} Version */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */

/**
 * @typedef {import('../../../logger').Logger} Logger
 */

/**
 * Thrown when the remote hostname's stored `meta/version` does not match the
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compare two ISO-8601 date strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * `undefined` is treated as the oldest possible value (before any real timestamp).
 *
 * ISO 8601 UTC timestamps (ending in 'Z') are lexicographically ordered,
 * so plain string comparison produces the correct temporal ordering.
 *
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @returns {number}
 */
function compareIsoTimestamps(a, b) {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Copy the entire contents of replica `from` into replica `to`,
 * clearing `to` first so no stale keys survive.
 * After copying, ensures `to`'s meta/version is always set to the
 * current application version — even when the source replica is empty
 * and `dst.batch([])` would otherwise perform no writes at all.
 *
 * @param {RootDatabase} rootDatabase
 * @param {ReplicaName} from
 * @param {ReplicaName} to
 * @returns {Promise<void>}
 */
async function copyReplicaBitIdentically(rootDatabase, from, to) {
    await rootDatabase.clearReplicaStorage(to);

    const src = rootDatabase.schemaStorageForReplica(from);
    const dst = rootDatabase.schemaStorageForReplica(to);

    /** @type {DatabaseBatchOperation[]} */
    let pending = [];

    /**
     * Flush full chunks of `pending` to `dst`, leaving any partial chunk
     * queued.  Tracks a start index and slices only the remaining tail once at
     * the end, so total slice work is O(remaining) instead of O(N) per batch.
     * @returns {Promise<void>}
     */
    async function flushPendingOps() {
        let i = 0;
        while (i + RAW_BATCH_CHUNK_SIZE <= pending.length) {
            await dst.batch(pending.slice(i, i + RAW_BATCH_CHUNK_SIZE));
            i += RAW_BATCH_CHUNK_SIZE;
        }
        if (i > 0) {
            pending = pending.slice(i);
        }
    }

    // Only `values` entries are chunked because their values can be
    // arbitrarily large (node computation results).  The other sublevels
    // (freshness, inputs, counters, timestamps) store bounded-size metadata
    // and may be accumulated without chunking.
    //
    // `revdeps` are intentionally NOT copied here: mergeHostIntoReplica always
    // deletes and rebuilds the entire revdeps index from the merged dependency
    // map.  Copying them here would waste I/O only to have them overwritten.
    for await (const key of src.values.keys()) {
        const v = await src.values.get(key);
        if (v !== undefined) {
            pending.push(dst.values.putOp(key, v));
            await flushPendingOps();
        }
    }
    for await (const key of src.freshness.keys()) {
        const v = await src.freshness.get(key);
        if (v !== undefined) {
            pending.push(dst.freshness.putOp(key, v));
        }
    }
    for await (const key of src.inputs.keys()) {
        const v = await src.inputs.get(key);
        if (v !== undefined) {
            pending.push(dst.inputs.putOp(key, v));
        }
    }
    for await (const key of src.counters.keys()) {
        const v = await src.counters.get(key);
        if (v !== undefined) {
            pending.push(dst.counters.putOp(key, v));
        }
    }
    for await (const key of src.timestamps.keys()) {
        const v = await src.timestamps.get(key);
        if (v !== undefined) {
            pending.push(dst.timestamps.putOp(key, v));
        }
    }

    if (pending.length > 0) {
        await dst.batch(pending);
    }

    // Guarantee that `to` always carries the current application version,
    // even when `pending` was empty throughout (source replica has no data).
    // When pending was non-empty, dst.batch() already initialized the version via
    // buildSchemaStorage's first-write check; this call is idempotent.
    // When pending was always empty, dst.batch() was never called, so without
    // this call the switched-to replica would have no version and the next host
    // merge would fail with HostVersionMismatchError.
    await rootDatabase.setMetaVersionForReplica(to, rootDatabase.version);
}

/**
 * Build "take" batch operations that copy a node's full data from H into T.
 * Copies value, freshness, timestamps, inputs, and counters.
 * revdeps are NOT copied here; they are rebuilt from scratch at the end.
 *
 * @param {SchemaStorage} T - Target (inactive) replica storage.
 * @param {SchemaStorage} H - Hostname staging storage.
 * @param {NodeKeyString} key
 * @returns {Promise<DatabaseBatchOperation[]>}
 */
async function buildTakeOps(T, H, key) {
    /** @type {DatabaseBatchOperation[]} */
    const ops = [];

    const hValue = await H.values.get(key);
    if (hValue !== undefined) {
        ops.push(T.values.putOp(key, hValue));
    } else {
        ops.push(T.values.delOp(key));
    }

    const hFreshness = await H.freshness.get(key);
    ops.push(T.freshness.putOp(key, hFreshness !== undefined ? hFreshness : 'potentially-outdated'));

    const hTimestamps = await H.timestamps.get(key);
    if (hTimestamps !== undefined) {
        ops.push(T.timestamps.putOp(key, hTimestamps));
    } else {
        ops.push(T.timestamps.delOp(key));
    }

    const hInputs = await H.inputs.get(key);
    if (hInputs !== undefined) {
        ops.push(T.inputs.putOp(key, hInputs));
    } else {
        ops.push(T.inputs.delOp(key));
    }

    const hCounter = await H.counters.get(key);
    if (hCounter !== undefined) {
        ops.push(T.counters.putOp(key, hCounter));
    } else {
        ops.push(T.counters.delOp(key));
    }

    return ops;
}

/**
 * Build the complete revdeps index from the merged dependency map.
 * Returns batch operations that delete all existing revdeps and write the
 * freshly computed ones.
 *
 * Using `mergedInputsMap` (rather than re-reading T and H per-node) ensures
 * that nodes whose initial decision was 'take' (and thus used H.inputs for
 * the topo sort and taint propagation) continue to use H.inputs for revdeps
 * even if taint propagation subsequently changed their decision to 'invalidate'.
 *
 * @param {SchemaStorage} T
 * @param {Map<NodeKeyString, NodeKeyString[]>} mergedInputsMap
 * @returns {Promise<DatabaseBatchOperation[]>}
 */
async function buildRebuildRevdepsOps(T, mergedInputsMap) {
    /** @type {DatabaseBatchOperation[]} */
    const ops = [];

    // Delete all existing revdeps.
    for await (const key of T.revdeps.keys()) {
        ops.push(T.revdeps.delOp(key));
    }

    // Rebuild from the merged inputs map.
    /** @type {Map<string, Set<NodeKeyString>>} */
    const newRevdepsMap = new Map();

    for (const [node, inputKeys] of mergedInputsMap) {
        for (const inputKey of inputKeys) {
            const inputStr = String(inputKey);
            const existing = newRevdepsMap.get(inputStr);
            if (existing) {
                existing.add(node);
            } else {
                newRevdepsMap.set(inputStr, new Set([node]));
            }
        }
    }

    for (const [inputStr, depSet] of newRevdepsMap) {
        const inputKey = stringToNodeKeyString(inputStr);
        const dependents = [...depSet].sort(compareNodeKeyStringByNodeKey);
        ops.push(T.revdeps.putOp(inputKey, dependents));
    }

    return ops;
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
 * @returns {Promise<void>}
 * @throws {HostVersionMismatchError} If the remote's schema version differs from local.
 * @throws {import('./topo_sort').TopologicalSortCycleError} If the graph has a cycle.
 */
async function mergeHostIntoReplica(logger, rootDatabase, hostname) {
    // ── Step 0: Version check ────────────────────────────────────────────────
    const localVersionRaw = await rootDatabase.getMetaVersion();
    const localVersion = localVersionRaw !== undefined ? versionToString(localVersionRaw) : undefined;
    const remoteVersionRaw = await rootDatabase.getHostnameMetaVersion(hostname);
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

    // ── Step 1: Copy L → T bit-identically ──────────────────────────────────
    await copyReplicaBitIdentically(rootDatabase, fromReplica, toReplica);

    const T = rootDatabase.schemaStorageForReplica(toReplica);
    const H = rootDatabase.hostnameSchemaStorage(hostname);

    // ── Step 2: Collect nodes and build merged dependency map ────────────────
    //
    // Initial timestamp decisions are computed for all T nodes.  Then the
    // merged inputs map is built using H.inputs for every node whose initial
    // decision is 'take' and T.inputs for all others.  H-only nodes use
    // H.inputs.  This merged map is the single source of truth for both the
    // topological sort and the taint-propagation pass, which guarantees:
    //
    //   a) Cycle detection covers the full merged graph (including H-only
    //      additions and changed edges in taken nodes).
    //   b) Taint propagation correctly invalidates nodes whose ancestors
    //      change because a taken node rewired its inputs.

    // ── 2a: Per-node timestamp comparison for T nodes ─────────────────────────
    /** @type {Map<NodeKeyString, 'keep' | 'take'>} */
    const initialDecisions = new Map();
    /** @type {Set<NodeKeyString>} */
    const forceKeepRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const forceTakeRoots = new Set();

    for await (const node of T.inputs.keys()) {
        const tTimestamps = await T.timestamps.get(node);
        const hTimestamps = await H.timestamps.get(node);

        const cmp = compareIsoTimestamps(tTimestamps?.modifiedAt, hTimestamps?.modifiedAt);

        if (hTimestamps === undefined || cmp >= 0) {
            initialDecisions.set(node, 'keep');
            if (cmp > 0) {
                forceKeepRoots.add(node);
            }
        } else {
            initialDecisions.set(node, 'take');
            forceTakeRoots.add(node);
        }
    }

    // ── 2b: Discover H-only nodes ─────────────────────────────────────────────
    /** @type {Set<NodeKeyString>} */
    const hOnlyNodes = new Set();
    for await (const key of H.inputs.keys()) {
        if (!initialDecisions.has(key)) {
            hOnlyNodes.add(key);
        }
    }

    // ── 2c: Build merged inputs map ──────────────────────────────────────────
    // For 'take' nodes: use H.inputs (the remote may have rewired edges).
    // For 'keep' nodes: use T.inputs.
    // For H-only nodes: use H.inputs.
    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const mergedInputsMap = new Map();

    for (const [node, decision] of initialDecisions) {
        let record;
        if (decision === 'take') {
            // Use only H's inputs for taken nodes.  buildTakeOps deletes
            // T.inputs when H.inputs is absent, so the merged map must match
            // that: if H has no inputs record, this node has no inputs in the
            // merged graph (empty list).  Falling back to T.inputs here would
            // make mergedInputsMap inconsistent with the actual DB state after
            // the merge, leaving revdeps pointing to inputs that no longer exist.
            record = await H.inputs.get(node);
        } else {
            record = await T.inputs.get(node);
        }
        const inputKeys = record
            ? record.inputs.map(s => stringToNodeKeyString(s))
            : [];
        mergedInputsMap.set(node, inputKeys);
    }

    for (const key of hOnlyNodes) {
        const record = await H.inputs.get(key);
        const inputKeys = record
            ? record.inputs.map(s => stringToNodeKeyString(s))
            : [];
        mergedInputsMap.set(key, inputKeys);
    }

    // ── Step 3: Stable topological sort of the merged graph ──────────────────
    // topologicalSortFromMap also detects cycles in the merged graph, covering
    // both T→H edge changes (taken nodes) and H-only additions.
    const topoList = topologicalSortFromMap(mergedInputsMap);

    // ── Step 4: Propagate force-keep and force-take flags ─────────────────────
    // Uses the merged inputs map so that rewired edges from taken nodes are
    // correctly accounted for (e.g. a taken node that now depends on a
    // force-kept ancestor will be tainted from both sides → 'invalidate').
    /** @type {Set<NodeKeyString>} */
    const keepTainted = new Set(forceKeepRoots);
    /** @type {Set<NodeKeyString>} */
    const takeTainted = new Set(forceTakeRoots);

    for (const node of topoList) {
        const inputKeys = mergedInputsMap.get(node) ?? [];
        for (const inputKey of inputKeys) {
            if (keepTainted.has(inputKey)) keepTainted.add(node);
            if (takeTainted.has(inputKey)) takeTainted.add(node);
        }
    }

    // ── Step 5: Assign final decisions ──────────────────────────────────────
    /** @type {Map<NodeKeyString, 'keep' | 'take' | 'invalidate'>} */
    const decisions = new Map();

    for (const [node, initial] of initialDecisions) {
        const inKeep = keepTainted.has(node);
        const inTake = takeTainted.has(node);

        if (inKeep && inTake) {
            decisions.set(node, 'invalidate');
        } else if (inKeep) {
            decisions.set(node, 'keep');
        } else if (inTake) {
            decisions.set(node, 'take');
        } else {
            decisions.set(node, initial);
        }
    }

    // ── Step 6: Finalize H-only nodes ────────────────────────────────────────
    // H-only nodes are always taken, but their cached value may be stale if
    // any of their (merged-graph) ancestors were force-kept from T.
    /** @type {Set<NodeKeyString>} */
    const hOnlyNeedsInvalidate = new Set();

    for (const key of hOnlyNodes) {
        decisions.set(key, 'take');
        if (keepTainted.has(key)) {
            hOnlyNeedsInvalidate.add(key);
        }
    }

    // ── Step 7: Apply decisions to T in chunks ──────────────────────────────
    /** @type {DatabaseBatchOperation[]} */
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
            const takeOps = await buildTakeOps(T, H, node);
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
                const takeOps = await buildTakeOps(T, H, node);
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
                const hTimestamps = await H.timestamps.get(node);
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

    // Rebuild revdeps from scratch using the merged inputs map.
    // buildRebuildRevdepsOps uses mergedInputsMap directly, ensuring nodes
    // that were initially 'take' (H.inputs) but taint-propagated to 'invalidate'
    // still use H.inputs for revdeps (consistent with the merged graph).
    const revdepsOps = await buildRebuildRevdepsOps(T, mergedInputsMap);
    for (const op of revdepsOps) {
        pendingOps.push(op);
        await flushPendingOps();
    }

    if (pendingOps.length > 0) {
        await T.batch(pendingOps);
    }

    // ── Step 8: Switch active replica pointer ────────────────────────────────
    await rootDatabase.switchToReplica(toReplica);

    const kept = [...decisions.values()].filter(d => d === 'keep').length;
    const taken = [...decisions.values()].filter(d => d === 'take').length;
    const invalidated = [...decisions.values()].filter(d => d === 'invalidate').length;

    logger.logInfo(
        { hostname, fromReplica, toReplica, kept, taken, invalidated },
        'Graph merge completed for host'
    );
}

module.exports = {
    mergeHostIntoReplica,
    HostVersionMismatchError,
    isHostVersionMismatchError,
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
    isTopologicalSortCycleError,
};
