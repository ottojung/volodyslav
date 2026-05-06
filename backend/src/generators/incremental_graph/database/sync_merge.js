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
 *   8. Switches the active replica pointer to T only when merge decisions
 *      actually changed replica contents.
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
const { makeDbToDbAdapter, unifyStores } = require('./unification');

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
 * Gently unify the entire contents of replica `from` into replica `to`.
 * Only keys whose value differs are written; keys absent from the source
 * are deleted from the target.  This replaces the previous clear-then-copy
 * approach, minimising unnecessary writes.
 *
 * After unification, ensures `to`'s meta/version is always set to the
 * current application version — even when both replicas were already
 * identical and no data was written.
 *
 * @param {RootDatabase} rootDatabase
 * @param {ReplicaName} from
 * @param {ReplicaName} to
 * @returns {Promise<void>}
 */
async function copyReplicaGently(rootDatabase, from, to) {
    const src = rootDatabase.schemaStorageForReplica(from);
    const dst = rootDatabase.schemaStorageForReplica(to);

    // Set the target replica version BEFORE calling unifyStores.
    // SchemaStorage.batch() enforces meta/version on the first write and throws
    // SchemaBatchVersionError on mismatch.  After a successful migration the
    // inactive replica may still carry the previous app version, so any sync
    // that writes at least one key would fail during unification without this.
    //
    // It is safe to write to the inactive replica before cutover: its
    // intermediate state is irrelevant until switchToReplica() succeeds.
    await rootDatabase.setMetaVersionForReplica(to, rootDatabase.version);

    // Exclude revdeps: they will be recomputed from mergedInputsMap by
    // unifyRevdeps() after the merge.  Copying them here wastes I/O.
    await unifyStores(makeDbToDbAdapter(src, dst, { excludeSublevels: ['revdeps'] }));
    // One final fsync: all unification writes use sync:false for performance;
    // _rawSync() issues an empty batch with sync:true to durably flush the
    // WAL/database state without mutating any keys.
    await rootDatabase._rawSync();
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
 * Gently update the revdeps index in `T` to match the desired state derived
 * from `mergedInputsMap`.  Only entries that differ are written; stale entries
 * are deleted.
 *
 * This implements the same algorithm as unifyStores() but operates directly on
 * typed revdeps to avoid unsafe value coercions.
 *
 * @param {SchemaStorage} T
 * @param {Map<NodeKeyString, NodeKeyString[]>} mergedInputsMap
 * @returns {Promise<void>}
 */
async function unifyRevdeps(T, mergedInputsMap) {
    // Compute the desired revdeps state from the merged inputs map.
    // Use a Set per input key to automatically deduplicate dependents — an
    // InputsRecord may contain the same input key more than once, and writing
    // duplicate entries would trigger spurious downstream recomputation.
    //
    // Memory: O(num_edges) — we hold the full desired revdeps map before
    // writing.  This is bounded by the number of nodes+edges in the graph,
    // not by value sizes, so it fits within the O(n) target where
    // n = max(max_value_size, num_nodes + num_edges).
    /** @type {Map<string, Set<NodeKeyString>>} */
    const desiredSets = new Map();

    for (const [node, inputKeys] of mergedInputsMap) {
        for (const inputKey of inputKeys) {
            const inputStr = String(inputKey);
            const existing = desiredSets.get(inputStr);
            if (existing) {
                existing.add(node);
            } else {
                desiredSets.set(inputStr, new Set([node]));
            }
        }
    }

    // Convert to sorted arrays for determinism and stable serialisation.
    /** @type {Map<string, NodeKeyString[]>} */
    const desired = new Map();
    for (const [key, depSet] of desiredSets) {
        desired.set(key, [...depSet].sort(compareNodeKeyStringByNodeKey));
    }

    // Materialise the current target key set.
    /** @type {Set<string>} */
    const targetKeys = new Set();
    for await (const key of T.revdeps.keys()) {
        targetKeys.add(String(key));
    }

    // Accumulate ops for batch writes chunked by RAW_BATCH_CHUNK_SIZE.
    // Memory: O(RAW_BATCH_CHUNK_SIZE × avg_revdep_size) per chunk — revdep
    // values are small (arrays of node-key strings), so each chunk is bounded.
    /** @type {DatabaseBatchOperation[]} */
    const ops = [];
    for (const [inputStr, dependents] of desired) {
        const inputKey = stringToNodeKeyString(inputStr);
        if (!targetKeys.has(inputStr)) {
            ops.push(T.revdeps.putOp(inputKey, dependents));
        } else {
            const existing = await T.revdeps.get(inputKey);
            if (JSON.stringify(existing) !== JSON.stringify(dependents)) {
                ops.push(T.revdeps.putOp(inputKey, dependents));
            }
        }
        if (ops.length >= RAW_BATCH_CHUNK_SIZE) {
            await T.batch(ops.splice(0, ops.length));
        }
    }

    // Delete stale entries.
    for (const existingKey of targetKeys) {
        if (!desired.has(existingKey)) {
            ops.push(T.revdeps.delOp(stringToNodeKeyString(existingKey)));
        }
        if (ops.length >= RAW_BATCH_CHUNK_SIZE) {
            await T.batch(ops.splice(0, ops.length));
        }
    }

    if (ops.length > 0) {
        await T.batch(ops);
    }
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
 * - The active replica pointer is switched to the (previously inactive)
 *   replica only if the merge introduced data changes.
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
    let mergeChangedReplica = false;

    logger.logInfo(
        { hostname, fromReplica, toReplica },
        'Starting graph merge for host'
    );

    // ── Step 1: Gently copy L → T ────────────────────────────────────────────
    await copyReplicaGently(rootDatabase, fromReplica, toReplica);

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
            mergeChangedReplica = true;
            const takeOps = await buildTakeOps(T, H, node);
            pendingOps.push(...takeOps);
            // H-only nodes whose ancestors include a locally-kept (T-newer) node
            // were computed on the remote with stale inputs.  Copy the structural
            // data from H so the node exists in T and the revdeps index is
            // correct, but override freshness to force recomputation.
            if (hOnlyNeedsInvalidate.has(node)) {
                const currentFreshness = await T.freshness.get(node);
                if (currentFreshness !== 'potentially-outdated') {
                    mergeChangedReplica = true;
                    pendingOps.push(T.freshness.putOp(node, 'potentially-outdated'));
                }
            }
        } else if (decision === 'invalidate') {
            // If the node was initially 'take' (H newer) but got tainted to
            // 'invalidate', we must still apply H's structural state first
            // (inputs/counters/values/timestamps) so T stays consistent with
            // mergedInputsMap and rebuilt revdeps. We then force freshness to
            // potentially-outdated to trigger recomputation.
            if (initialDecisions.get(node) === 'take') {
                mergeChangedReplica = true;
                const takeOps = await buildTakeOps(T, H, node);
                pendingOps.push(...takeOps);
            }
            const currentFreshness = await T.freshness.get(node);
            if (currentFreshness !== 'potentially-outdated') {
                mergeChangedReplica = true;
                pendingOps.push(T.freshness.putOp(node, 'potentially-outdated'));
            }
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
                    if (
                        tTimestamps === undefined ||
                        tTimestamps.createdAt !== advanced.createdAt ||
                        tTimestamps.modifiedAt !== advanced.modifiedAt
                    ) {
                        mergeChangedReplica = true;
                    }
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

    // Gently update revdeps using the merged inputs map.  Only changed entries
    // are written; stale entries are deleted.  unifyRevdeps uses mergedInputsMap
    // directly, ensuring nodes that were initially 'take' (H.inputs) but
    // taint-propagated to 'invalidate' still use H.inputs for revdeps.
    await unifyRevdeps(T, mergedInputsMap);

    // ── Step 8: Switch active replica pointer only if merge changed data ─────
    if (mergeChangedReplica) {
        await rootDatabase.switchToReplica(toReplica);
    }

    const kept = [...decisions.values()].filter(d => d === 'keep').length;
    const taken = [...decisions.values()].filter(d => d === 'take').length;
    const invalidated = [...decisions.values()].filter(d => d === 'invalidate').length;

    logger.logInfo(
        { hostname, fromReplica, toReplica, kept, taken, invalidated, mergeChangedReplica },
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
