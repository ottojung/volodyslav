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
 * 2. Copy `L` into `T`, excluding reverse dependencies because they are derived
 *    data and are rebuilt after decisions are applied.
 * 3. Parse and compare the target/host identifier lookup metadata. The current
 *    policy is deliberately conservative: equivalent semantic node keys must
 *    already use the same persisted identifier on both sides, and an identifier
 *    may not name different semantic keys.
 * 4. Build a merge plan from timestamps and the merged dependency graph. Newer
 *    local nodes are kept, newer host nodes are taken, and descendants of both a
 *    local-newer and host-newer ancestor are invalidated so they recompute from
 *    the merged inputs.
 * 5. Apply the plan to `T`, rebuilding `revdeps` from the same merged inputs map
 *    used by the planner.
 * 6. Persist the merged identifier lookup and switch the active replica pointer
 *    only if the plan took or invalidated at least one node.
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
} = require('./sync_merge_identifier_lookup');

/** @typedef {import('../../../logger').Logger} Logger */
/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./root_database').ReplicaName} ReplicaName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
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
 * Small helper around SchemaStorage.batch() that guarantees batch sizes never
 * exceed RAW_BATCH_CHUNK_SIZE while still allowing callers to build operations
 * incrementally.
 */
class ReplicaBatchWriter {
    /**
     * @param {SchemaStorage} storage
     */
    constructor(storage) {
        this._storage = storage;
        /** @type {Array<*>} */
        this._pendingOps = [];
    }

    /**
     * @param {Array<*>} operations
     * @returns {Promise<void>}
     */
    async pushAll(operations) {
        this._pendingOps.push(...operations);
        await this.flushCompleteChunks();
    }

    /**
     * @param {*} operation
     * @returns {Promise<void>}
     */
    async push(operation) {
        this._pendingOps.push(operation);
        await this.flushCompleteChunks();
    }

    /**
     * Flush full chunks and leave any partial chunk queued.
     * @returns {Promise<void>}
     */
    async flushCompleteChunks() {
        while (this._pendingOps.length >= RAW_BATCH_CHUNK_SIZE) {
            const chunk = this._pendingOps.slice(0, RAW_BATCH_CHUNK_SIZE);
            await this._storage.batch(chunk);
            this._pendingOps = this._pendingOps.slice(RAW_BATCH_CHUNK_SIZE);
        }
    }

    /**
     * Flush all queued operations. No-op when the queue is empty.
     * @returns {Promise<void>}
     */
    async flush() {
        await this.flushCompleteChunks();
        if (this._pendingOps.length === 0) {
            return;
        }
        await this._storage.batch(this._pendingOps);
        this._pendingOps = [];
    }
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
 * Load and validate identifier lookup metadata for the merge target and host.
 * Missing host metadata is always an error because each staged identifier-native
 * host snapshot must carry its own semantic identifier mapping. Missing target
 * metadata is allowed only for a genuinely fresh local replica with no version.
 *
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @returns {Promise<{ targetLookup: IdentifierLookup, hostLookup: IdentifierLookup }>}
 */
async function loadMergeIdentifierLookups(targetStorage, hostStorage) {
    const hostLookup = parseIdentifierLookup(
        await hostStorage.global.get('identifiers_keys_map'),
        'staged host snapshot'
    );
    const targetRawLookup = await targetStorage.global.get('identifiers_keys_map');
    const targetVersion = await targetStorage.global.get('version');
    const targetLookup = targetRawLookup === undefined && targetVersion === undefined
        ? makeEmptyIdentifierLookup()
        : parseIdentifierLookup(targetRawLookup, 'merge target replica');

    assertNoIdentifierLookupConflicts(targetLookup, hostLookup);
    return { targetLookup, hostLookup };
}

/**
 * Apply a host-newer node to the target replica. If the planner determined the
 * host-only node is downstream of a locally-newer ancestor, the host's structure
 * is kept but freshness is overridden so the node recomputes locally.
 *
 * @param {ReplicaBatchWriter} writer
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {NodeIdentifier} node
 * @param {Set<NodeIdentifier>} hostOnlyNodesNeedingInvalidation
 * @returns {Promise<void>}
 */
async function applyTakeDecision(
    writer,
    targetStorage,
    hostStorage,
    node,
    hostOnlyNodesNeedingInvalidation
) {
    await writer.pushAll(await buildTakeOps(
        targetStorage,
        hostStorage,
        node
    ));

    if (hostOnlyNodesNeedingInvalidation.has(node)) {
        await writer.push(targetStorage.freshness.putOp(node, 'potentially-outdated'));
    }
}

/**
 * Copy a host-newer node's structural state before invalidating it. This keeps
 * `inputs`, counters, values, and timestamps aligned with the merged dependency
 * graph while forcing recomputation of the final value.
 *
 * @param {ReplicaBatchWriter} writer
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {NodeIdentifier} node
 * @returns {Promise<void>}
 */
async function copyHostStateForInvalidatedTake(writer, targetStorage, hostStorage, node) {
    await writer.pushAll(await buildTakeOps(
        targetStorage,
        hostStorage,
        node
    ));
}

/**
 * Advance modifiedAt for a host-newer invalidated node so a later sync does not
 * repeatedly rediscover the same host timestamp as newer. The node remains
 * `potentially-outdated`, so the next read/recompute still derives a local value
 * from the merged inputs.
 *
 * @param {ReplicaBatchWriter} writer
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {NodeIdentifier} node
 * @returns {Promise<void>}
 */
async function advanceInvalidatedTakeTimestamp(writer, targetStorage, hostStorage, node) {
    const hostTimestamps = await hostStorage.timestamps.get(node);
    if (hostTimestamps === undefined) {
        return;
    }

    const targetTimestamps = await targetStorage.timestamps.get(node);
    await writer.push(targetStorage.timestamps.putOp(node, {
        createdAt: targetTimestamps?.createdAt ?? hostTimestamps.createdAt,
        modifiedAt: hostTimestamps.modifiedAt,
    }));
}

/**
 * Apply an invalidate decision to the target replica.
 *
 * A node that was initially `take` has newer host structural data. The merge must
 * copy that host state before invalidating freshness; otherwise the rebuilt
 * revdeps index and the node's stored inputs would disagree. A node initially
 * kept already has the target structure that the planner used.
 *
 * @param {ReplicaBatchWriter} writer
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {Map<NodeIdentifier, 'keep' | 'take'>} initialDecisions
 * @param {NodeIdentifier} node
 * @returns {Promise<void>}
 */
async function applyInvalidateDecision(writer, targetStorage, hostStorage, initialDecisions, node) {
    const initiallyTaken = initialDecisions.get(node) === 'take';
    if (initiallyTaken) {
        await copyHostStateForInvalidatedTake(writer, targetStorage, hostStorage, node);
    }

    await writer.push(targetStorage.freshness.putOp(node, 'potentially-outdated'));

    if (initiallyTaken) {
        await advanceInvalidatedTakeTimestamp(writer, targetStorage, hostStorage, node);
    }
}

/**
 * Apply all node decisions to the target replica. Reverse dependencies and
 * global identifier metadata are intentionally excluded; callers update those
 * after node records are coherent.
 *
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {Map<NodeIdentifier, 'keep' | 'take'>} initialDecisions
 * @param {Map<NodeIdentifier, MergeDecision>} decisions
 * @param {Set<NodeIdentifier>} hostOnlyNodesNeedingInvalidation
 * @returns {Promise<void>}
 */
async function applyNodeDecisions(
    targetStorage,
    hostStorage,
    initialDecisions,
    decisions,
    hostOnlyNodesNeedingInvalidation
) {
    const writer = new ReplicaBatchWriter(targetStorage);

    for (const [node, decision] of decisions) {
        if (decision === 'take') {
            await applyTakeDecision(
                writer,
                targetStorage,
                hostStorage,
                node,
                hostOnlyNodesNeedingInvalidation
            );
        } else if (decision === 'invalidate') {
            await applyInvalidateDecision(
                writer,
                targetStorage,
                hostStorage,
                initialDecisions,
                node
            );
        }
    }

    await writer.flush();
}

/**
 * @param {Iterable<MergeDecision>} decisions
 * @returns {{ kept: number, taken: number, invalidated: number, hasChanges: boolean }}
 */
function summarizeDecisions(decisions) {
    let kept = 0;
    let taken = 0;
    let invalidated = 0;

    for (const decision of decisions) {
        if (decision === 'keep') {
            kept += 1;
        } else if (decision === 'take') {
            taken += 1;
        } else {
            invalidated += 1;
        }
    }

    return {
        kept,
        taken,
        invalidated,
        hasChanges: taken + invalidated > 0,
    };
}

/**
 * Persist metadata and derived indexes that are updated only when graph records
 * changed. `mergedInputsMap` must be the exact map produced by the planner so
 * invalidated host-newer nodes get revdeps for their copied host inputs.
 *
 * @param {RootDatabase} rootDatabase
 * @param {SchemaStorage} targetStorage
 * @param {ReplicaName} targetReplica
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @returns {Promise<void>}
 */
async function commitChangedMerge(
    rootDatabase,
    targetStorage,
    targetReplica,
    targetLookup,
    hostLookup,
    mergedInputsMap
) {
    const mergedLookup = mergeIdentifierLookups(targetLookup, hostLookup);
    const writer = new ReplicaBatchWriter(targetStorage);
    await writer.push(targetStorage.global.putOp(
        'identifiers_keys_map',
        serializeIdentifierLookup(mergedLookup)
    ));
    await writer.flush();

    await unifyRevdeps(targetStorage, mergedInputsMap);
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
 * - If the merge took or invalidated any node, the inactive replica contains the
 *   merged graph and is made active.
 * - If every node was kept, the active replica pointer is unchanged. The
 *   inactive replica may still have been refreshed as a copy of the active
 *   replica, but callers must continue reading from the active pointer.
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

    const fromReplica = rootDatabase.currentReplicaName();
    const toReplica = rootDatabase.otherReplicaName();

    logger.logInfo(
        { hostname, fromReplica, toReplica },
        'Starting graph merge for host'
    );

    await copyReplicaGently(rootDatabase, fromReplica, toReplica);

    const targetStorage = rootDatabase.schemaStorageForReplica(toReplica);
    const hostStorage = rootDatabase.hostnameSchemaStorage(hostname);
    const { targetLookup, hostLookup } = await loadMergeIdentifierLookups(targetStorage, hostStorage);

    const {
        initialDecisions,
        mergedInputsMap,
        decisions,
        hOnlyNeedsInvalidate,
    } = await buildMergePlan(
        targetStorage,
        hostStorage
    );

    await applyNodeDecisions(
        targetStorage,
        hostStorage,
        initialDecisions,
        decisions,
        hOnlyNeedsInvalidate
    );

    const summary = summarizeDecisions(decisions.values());
    if (summary.hasChanges) {
        await commitChangedMerge(
            rootDatabase,
            targetStorage,
            toReplica,
            targetLookup,
            hostLookup,
            mergedInputsMap
        );
    }

    logger.logInfo(
        {
            hostname,
            fromReplica,
            toReplica,
            kept: summary.kept,
            taken: summary.taken,
            invalidated: summary.invalidated,
            switchedReplica: summary.hasChanges,
        },
        'Graph merge completed for host'
    );
    return summary.hasChanges;
}

module.exports = {
    mergeHostIntoReplica,
    HostVersionMismatchError,
    isHostVersionMismatchError,
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
    isTopologicalSortCycleError,
};
