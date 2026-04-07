/**
 * Per-host graph merge algorithm for incremental-graph sync.
 *
 * This module implements the structured, LevelDB-level merge that replaces the
 * previous git-textual merge.  For each remote hostname, the algorithm:
 *
 *   1. Copies the active local replica L into the inactive replica T
 *      bit-identically (L and T become identical).
 *   2. Builds a stable topological ordering of T's nodes.
 *   3. Computes initial decisions per-node from modification timestamps:
 *      - T-newer (or H absent) → 'keep'; if strictly newer, flag as force-keep root.
 *      - H-newer → 'take'; flag as force-take root.
 *      - Equal timestamps → 'keep'.
 *   4. Propagates force-keep and force-take flags through the topological order,
 *      so each node inherits the taint of its most-upstream forced ancestor.
 *   5. Nodes tainted by both force-keep and force-take are 'invalidate'.
 *   6. Nodes present in H but absent in T are taken in full (additions from remote;
 *      valid because nodes cannot be deleted from a graph).
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
 */

const { topologicalSort, isTopologicalSortCycleError } = require('./topo_sort');
const { stringToNodeKeyString, versionToString } = require('./types');
const { compareNodeKeyStringByNodeKey } = require('./node_key');

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
 * Version is also copied so the version check in the target's batch() passes.
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
    const ops = [];

    for await (const key of src.values.keys()) {
        const v = await src.values.get(key);
        if (v !== undefined) ops.push(dst.values.putOp(key, v));
    }
    for await (const key of src.freshness.keys()) {
        const v = await src.freshness.get(key);
        if (v !== undefined) ops.push(dst.freshness.putOp(key, v));
    }
    for await (const key of src.inputs.keys()) {
        const v = await src.inputs.get(key);
        if (v !== undefined) ops.push(dst.inputs.putOp(key, v));
    }
    for await (const key of src.revdeps.keys()) {
        const v = await src.revdeps.get(key);
        if (v !== undefined) ops.push(dst.revdeps.putOp(key, v));
    }
    for await (const key of src.counters.keys()) {
        const v = await src.counters.get(key);
        if (v !== undefined) ops.push(dst.counters.putOp(key, v));
    }
    for await (const key of src.timestamps.keys()) {
        const v = await src.timestamps.get(key);
        if (v !== undefined) ops.push(dst.timestamps.putOp(key, v));
    }

    await dst.batch(ops);
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
 * Build the complete revdeps index from T's inputs records.
 * Returns batch operations that delete all existing revdeps and write the
 * freshly computed ones.
 *
 * @param {SchemaStorage} T
 * @param {Map<NodeKeyString, 'keep' | 'take' | 'invalidate'>} decisions
 * @param {SchemaStorage} H
 * @param {Set<NodeKeyString>} hOnlyNodes
 * @returns {Promise<DatabaseBatchOperation[]>}
 */
async function buildRebuildRevdepsOps(T, decisions, H, hOnlyNodes) {
    /** @type {DatabaseBatchOperation[]} */
    const ops = [];

    // Delete all existing revdeps.
    for await (const key of T.revdeps.keys()) {
        ops.push(T.revdeps.delOp(key));
    }

    // Rebuild from the merged inputs.
    /** @type {Map<string, Set<NodeKeyString>>} */
    const newRevdepsMap = new Map();

    // All nodes that will exist in the merged T (including H-only additions).
    const allMergedNodes = new Set([
        ...[...decisions.keys()],
        ...hOnlyNodes,
    ]);

    for (const node of allMergedNodes) {
        const decision = decisions.get(node);
        let inputsRecord;
        if (decision === 'take' || hOnlyNodes.has(node)) {
            // Taken nodes and H-only nodes use H's inputs.
            inputsRecord = await H.inputs.get(node);
        } else {
            inputsRecord = await T.inputs.get(node);
        }
        if (!inputsRecord) continue;
        for (const inputStr of inputsRecord.inputs) {
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

    // ── Step 2: Stable topological sort of T ────────────────────────────────
    const topoList = await topologicalSort(T);

    // ── Step 3: Compute initial per-node decisions from timestamp comparison ─
    // 'keep': T is equal or newer (or H has no entry).
    // 'take': H is strictly newer.
    /** @type {Map<NodeKeyString, 'keep' | 'take'>} */
    const initialDecisions = new Map();
    /** @type {Set<NodeKeyString>} */
    const forceKeepRoots = new Set(); // Nodes where T is strictly newer than H.
    /** @type {Set<NodeKeyString>} */
    const forceTakeRoots = new Set(); // Nodes where H is strictly newer than T.

    for (const node of topoList) {
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

    // ── Step 4: Propagate force-keep and force-take flags in topological order
    // A node is keepTainted if it is (transitively) downstream of a T-newer node.
    // A node is takeTainted if it is (transitively) downstream of an H-newer node.
    // Taint propagation is O(N + E): for each node, inherit taint from inputs.
    /** @type {Set<NodeKeyString>} */
    const keepTainted = new Set(forceKeepRoots);
    /** @type {Set<NodeKeyString>} */
    const takeTainted = new Set(forceTakeRoots);

    for (const node of topoList) {
        const inputsRecord = await T.inputs.get(node);
        if (!inputsRecord) continue;
        for (const inputStr of inputsRecord.inputs) {
            const inputKey = stringToNodeKeyString(inputStr);
            if (keepTainted.has(inputKey)) keepTainted.add(node);
            if (takeTainted.has(inputKey)) takeTainted.add(node);
        }
    }

    // ── Step 5: Assign final decisions ──────────────────────────────────────
    // Nodes in both taints are invalidated (mixed-ancestry conflict).
    /** @type {Map<NodeKeyString, 'keep' | 'take' | 'invalidate'>} */
    const decisions = new Map();

    for (const node of topoList) {
        const inKeep = keepTainted.has(node);
        const inTake = takeTainted.has(node);

        if (inKeep && inTake) {
            decisions.set(node, 'invalidate');
        } else if (inKeep) {
            decisions.set(node, 'keep');
        } else if (inTake) {
            decisions.set(node, 'take');
        } else {
            const base = initialDecisions.get(node) ?? 'keep';
            decisions.set(node, base);
        }
    }

    // ── Step 6: Handle H-only nodes (additions from remote) ─────────────────
    // Nodes present in H but absent in T are additions from the remote side.
    // Nodes cannot be deleted from a graph, so H having more nodes means they
    // were added remotely.
    //
    // However, H-only nodes may depend (via their inputs) on T-present nodes
    // that have force-keep taint.  Such a node was computed on the remote using
    // an older version of an ancestor that T has already updated locally.  Its
    // cached value is therefore stale.  We still take all structural data from H
    // (so the node exists in T and the revdeps index is correct) but we override
    // the freshness to `potentially-outdated`.
    /** @type {Set<NodeKeyString>} */
    const hOnlyNodes = new Set();
    for await (const key of H.inputs.keys()) {
        if (!decisions.has(key)) {
            hOnlyNodes.add(key);
        }
    }

    // Propagate keepTainted / takeTainted through the H-only sub-graph using
    // a recursive DFS so that chains of H-only nodes are handled correctly.
    // Nodes are visited at most once (guarded by `hOnlyVisited`).
    const hOnlyVisited = new Set();

    /**
     * @param {NodeKeyString} key
     * @returns {Promise<void>}
     */
    async function propagateTaintToHOnly(key) {
        if (hOnlyVisited.has(key)) return;
        hOnlyVisited.add(key);
        const hInputsRecord = await H.inputs.get(key);
        if (!hInputsRecord) return;
        for (const inputStr of hInputsRecord.inputs) {
            const inputKey = stringToNodeKeyString(inputStr);
            // Propagate through any H-only predecessors first.
            if (hOnlyNodes.has(inputKey)) {
                await propagateTaintToHOnly(inputKey);
            }
            if (keepTainted.has(inputKey)) keepTainted.add(key);
            if (takeTainted.has(inputKey)) takeTainted.add(key);
        }
    }

    for (const key of hOnlyNodes) {
        await propagateTaintToHOnly(key);
    }

    // Track which H-only nodes need a freshness override after being taken.
    // A node is stale if any of its ancestors (transitively) were kept from T
    // (keepTainted), meaning it was computed on the remote with stale inputs.
    /** @type {Set<NodeKeyString>} */
    const hOnlyNeedsInvalidate = new Set();
    for (const key of hOnlyNodes) {
        decisions.set(key, 'take');
        if (keepTainted.has(key)) {
            hOnlyNeedsInvalidate.add(key);
        }
    }

    // ── Step 7: Apply decisions to T ────────────────────────────────────────
    /** @type {DatabaseBatchOperation[]} */
    const ops = [];

    for (const [node, decision] of decisions) {
        if (decision === 'take') {
            const takeOps = await buildTakeOps(T, H, node);
            ops.push(...takeOps);
            // H-only nodes whose ancestors include a locally-kept (T-newer) node
            // were computed on the remote with stale inputs.  Copy the structural
            // data from H so the node exists in T and the revdeps index is
            // correct, but override freshness to force recomputation.
            if (hOnlyNeedsInvalidate.has(node)) {
                ops.push(T.freshness.putOp(node, 'potentially-outdated'));
            }
        } else if (decision === 'invalidate') {
            ops.push(T.freshness.putOp(node, 'potentially-outdated'));
        }
        // 'keep': no write operations needed; T already has the correct data.
    }

    // Rebuild revdeps from scratch.
    const revdepsOps = await buildRebuildRevdepsOps(T, decisions, H, hOnlyNodes);
    ops.push(...revdepsOps);

    await T.batch(ops);

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
