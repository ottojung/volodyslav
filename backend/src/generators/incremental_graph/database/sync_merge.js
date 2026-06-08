/**
 * Per-host graph merge for incremental-graph synchronization.
 *
 * Synchronization stages each remote hostname into `hostnames/<hostname>` (the
 * host storage, `H`). This module merges that staged graph into the inactive
 * local replica (`T`) and, only when the merge changes graph data or
 * identifier assignments, makes `T` the active replica. The currently-active
 * local replica (`L`) is never modified by this function.
 *
 * The merge is graph-aware and semantic-key-based:
 *
 * 1. Verify that `H` was written by the same schema version as the local
 *    database.
 * 2. Copy `L` into `T`, excluding reverse dependencies because they are derived
 *    data and are rebuilt after decisions are applied.
 * 3. Parse the target/host identifier lookups. Same-identifier/different-key
 *    is a hard error (corruption). Same-key/different-identifier is a normal
 *    merge scenario handled by the semantic-key-based planner.
 * 4. Build a merge plan from timestamps and the merged dependency graph,
 *    operating over semantic node keys. Newer local nodes are kept, newer host
 *    nodes are taken, and descendants of both a local-newer and host-newer
 *    ancestor are invalidated.
 * 5. Apply the plan to `T`: copy take/invalidate data with input lowering,
 *    delete losing identifiers, rebuild `revdeps`.
 * 6. Construct the final identifier lookup from the merge plan and persist it.
 *    Switch the active replica pointer when there are graph changes or
 *    identifier changes.
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
const { versionToString, nodeKeyStringToString, nodeIdentifierToString } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');
const {
    IDENTIFIERS_KEY,
    makeEmptyIdentifierLookup,
    serializeIdentifierLookup,
    setIdentifierMapping,
} = require('./identifier_lookup');
const { LAST_NODE_INDEX_KEY } = require('./root_database');
const { buildMergePlan } = require('./sync_merge_plan');
const { unifyRevdeps } = require('./sync_merge_revdeps');
const { buildDeleteOps, copyNodeOps, copyReplicaGently } = require('./sync_merge_transfer');
const {
    assertNoIdentifierLookupConflicts,
    assertFinalLookupIsBisection,
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
 * Apply a take decision with cross-identifier copy. Used when sourceId and
 * destinationId differ (same key/different ID take), or for host-only nodes
 * whose inputs may need lowering.
 *
 * @param {ReplicaBatchWriter} writer
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {NodeIdentifier} sourceId
 * @param {NodeIdentifier} destinationId
 * @param {NodeIdentifier[]} finalInputs
 * @param {boolean} needsInvalidate
 * @returns {Promise<void>}
 */
async function applyTakeWithCopy(writer, targetStorage, hostStorage, sourceId, destinationId, finalInputs, needsInvalidate) {
    await writer.pushAll(await copyNodeOps({
        targetStorage,
        sourceStorage: hostStorage,
        sourceId,
        destinationId,
        finalInputs,
    }));

    if (needsInvalidate) {
        await writer.push(targetStorage.freshness.putOp(destinationId, 'potentially-outdated'));
    }
}

/**
 * Apply all node decisions to the target replica using the semantic-key-based
 * merge plan. Reverse dependencies and global identifier metadata are
 * intentionally excluded; callers update those after node records are coherent.
 *
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Map<NodeKeyString, 'keep' | 'take'>} initialDecisions
 * @param {Map<NodeKeyString, MergeDecision>} decisions
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @param {Set<NodeIdentifier>} hostOnlyNodesNeedingInvalidation
 * @returns {Promise<void>}
 */
async function applyNodeDecisions(
    targetStorage,
    hostStorage,
    targetLookup,
    hostLookup,
    initialDecisions,
    decisions,
    finalIdentifierForKey,
    mergedInputsMap,
    hostOnlyNodesNeedingInvalidation
) {
    const writer = new ReplicaBatchWriter(targetStorage);

    for (const [nodeKey, decision] of decisions) {
        const targetId = targetLookup.keyToId.get(nodeKeyStringToString(nodeKey));
        const hostId = hostLookup.keyToId.get(nodeKeyStringToString(nodeKey));
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId === undefined) continue;

        const loweredInputs = mergedInputsMap.get(finalId) ?? [];

        if (decision === 'take') {
            const needsInvalidate = hostOnlyNodesNeedingInvalidation.has(finalId);
            const sourceId = hostId ?? finalId;

            await applyTakeWithCopy(writer, targetStorage, hostStorage, sourceId, finalId, loweredInputs, needsInvalidate);

            // Delete losing target identifier if the key was shared and host won.
            if (targetId !== undefined && targetId !== sourceId && targetId !== finalId) {
                await writer.pushAll(buildDeleteOps(targetStorage, targetId));
            }
        } else if (decision === 'invalidate') {
            const initial = initialDecisions.get(nodeKey);

            if (initial === 'take') {
                const sourceId = hostId ?? finalId;

                await applyTakeWithCopy(writer, targetStorage, hostStorage, sourceId, finalId, loweredInputs, false);
                await writer.push(targetStorage.freshness.putOp(finalId, 'potentially-outdated'));
                await advanceInvalidatedTakeTimestamp(writer, targetStorage, hostStorage, finalId);

                // Delete losing target identifier if the key was shared.
                if (targetId !== undefined && targetId !== sourceId && targetId !== finalId) {
                    await writer.pushAll(buildDeleteOps(targetStorage, targetId));
                }
        } else {
            // initial keep: rewrite inputs and set freshness.
            const existingInputs = await targetStorage.inputs.get(finalId);
            await writer.push(targetStorage.inputs.putOp(finalId, {
                inputs: loweredInputs.map(id => nodeIdentifierToString(id)),
                inputCounters: existingInputs?.inputCounters ?? [],
            }));
            await writer.push(targetStorage.freshness.putOp(finalId, 'potentially-outdated'));
        }
    } else if (decision === 'keep') {
        // Rewrite inputs; dependency identifiers may have changed.
        const existingInputs = await targetStorage.inputs.get(finalId);
        await writer.push(targetStorage.inputs.putOp(finalId, {
            inputs: loweredInputs.map(id => nodeIdentifierToString(id)),
            inputCounters: existingInputs?.inputCounters ?? [],
        }));
    }
}

    await writer.flush();
}

/**
 * Build the final identifier lookup from the merge plan.
 * Constructs a clean bijection from surviving semantic keys to final identifiers.
 *
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @returns {IdentifierLookup}
 */
function buildFinalLookup(finalIdentifierForKey) {
    const lookup = makeEmptyIdentifierLookup();

    for (const [nodeKey, finalId] of finalIdentifierForKey) {
        setIdentifierMapping(lookup, finalId, nodeKey);
    }

    return lookup;
}

/**
 * @param {Iterable<MergeDecision>} decisions
 * @param {boolean} identifierChanges
 * @returns {{ kept: number, taken: number, invalidated: number, hasChanges: boolean }}
 */
function summarizeDecisions(decisions, identifierChanges) {
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
        hasChanges: taken + invalidated > 0 || identifierChanges,
    };
}

/**
 * Persist metadata and derived indexes that are updated when graph records
 * changed or identifiers were reconciled.
 *
 * `mergedInputsMap` must be the exact lowered map produced by the planner so
 * invalidated host-newer nodes get revdeps for their copied host inputs.
 *
 * @param {RootDatabase} rootDatabase
 * @param {SchemaStorage} targetStorage
 * @param {ReplicaName} targetReplica
 * @param {IdentifierLookup} finalLookup
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @param {number} targetLastNodeIndex
 * @returns {Promise<void>}
 */
async function commitChangedMerge(
    rootDatabase,
    targetStorage,
    targetReplica,
    finalLookup,
    mergedInputsMap,
    targetLastNodeIndex
) {
    assertFinalLookupIsBisection(finalLookup, 'final lookup during merge commit');

    const writer = new ReplicaBatchWriter(targetStorage);
    await writer.push(targetStorage.global.putOp(
        IDENTIFIERS_KEY,
        serializeIdentifierLookup(finalLookup)
    ));
    await writer.push(targetStorage.global.putOp(
        LAST_NODE_INDEX_KEY,
        targetLastNodeIndex
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
 * - If the merge took or invalidated any node, or reconciled identifiers,
 *   the inactive replica contains the merged graph and is made active.
 * - If every node was kept and no identifier reconciliation was needed,
 *   the active replica pointer is unchanged.
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

    await copyReplicaGently(rootDatabase, fromReplica, toReplica);

    const targetStorage = rootDatabase.schemaStorageForReplica(toReplica);
    const targetLookup = await loadTargetLookup(targetStorage);
    assertNoIdentifierLookupConflicts(targetLookup, hostLookup);

    const targetLastNodeIndex = rootDatabase.getLastNodeIndex();

    const {
        initialDecisions,
        mergedInputsMap,
        decisions,
        finalIdentifierForKey,
        hOnlyNeedsInvalidate,
        identifierChanges,
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
        finalIdentifierForKey,
        mergedInputsMap,
        hOnlyNeedsInvalidate
    );

    const summary = summarizeDecisions(decisions.values(), identifierChanges);
    if (summary.hasChanges) {
        const finalLookup = buildFinalLookup(finalIdentifierForKey);
        await commitChangedMerge(
            rootDatabase,
            targetStorage,
            toReplica,
            finalLookup,
            mergedInputsMap,
            targetLastNodeIndex
        );
    }

    const switchedReplica = summary.hasChanges;
    logger.logInfo(
        {
            hostname,
            fromReplica,
            toReplica,
            kept: summary.kept,
            taken: summary.taken,
            invalidated: summary.invalidated,
            identifierChanges,
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
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
    isTopologicalSortCycleError,
};
