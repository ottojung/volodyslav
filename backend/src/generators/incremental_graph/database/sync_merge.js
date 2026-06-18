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
const { IdentifierLookupConflictError } = require('./replica_errors');
const { versionToString } = require('./types');
const {
    IDENTIFIERS_KEY,
    makeEmptyIdentifierLookup,
    serializeIdentifierLookup,
} = require('./identifier_lookup');
const { LAST_NODE_INDEX_KEY } = require('./root_database');
const { buildMergePlan } = require('./sync_merge_plan');
const {
    assertValidFinalMergeState,
    assertLookupCoversMaterializedNodes,
    FinalMergeStateError,
    isFinalMergeStateError,
} = require('./sync_merge_validation');
const { buildDeleteNodeOps, copyNodeOps, copyReplicaGently } = require('./sync_merge_transfer');
const { preserveAndRebuildValidity, ReplicaBatchWriter } = require('./sync_merge_validity');
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
 * Apply semantic decisions by copying the selected side into the final storage
 * identifier and writing planner-lowered inputs.
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Map<NodeKeyString, 'keep' | 'take'>} initialDecisions
 * @param {Map<NodeKeyString, MergeDecision>} decisions
 * @param {Set<NodeKeyString>} hostOnlyNodesNeedingInvalidation
 * @param {Set<NodeKeyString>} directlyReloweredNodes
 * @param {Set<NodeKeyString>} reloweringInvalidatedNodes
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @returns {Promise<void>}
 */
async function applyNodeDecisions(
    targetStorage,
    hostStorage,
    targetLookup,
    hostLookup,
    initialDecisions,
    decisions,
    hostOnlyNodesNeedingInvalidation,
    directlyReloweredNodes,
    reloweringInvalidatedNodes,
    finalIdentifierForKey,
    mergedInputsMap
) {
    const writer = new ReplicaBatchWriter(targetStorage);

    for (const [nodeKey, decision] of decisions) {
        const initial = initialDecisions.get(nodeKey);
        const destinationId = finalIdentifierForKey.get(nodeKey);
        if (initial === undefined || destinationId === undefined) {
            throw new IdentifierLookupConflictError(`Incomplete merge plan for ${String(nodeKey)}`);
        }
        const structuralSide = decision === 'invalidate' ? initial : decision;
        const useHost = structuralSide === 'take';
        const sourceStorage = useHost ? hostStorage : targetStorage;
        const sourceLookup = useHost ? hostLookup : targetLookup;
        const sourceId = sourceLookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined) throw new IdentifierLookupConflictError(`Missing source identifier for ${String(nodeKey)}`);

        const shouldCopy = decision !== 'keep' || sourceId !== destinationId ||
            directlyReloweredNodes.has(nodeKey);
        if (shouldCopy) {
            await writer.pushAll(await copyNodeOps({
                targetStorage,
                sourceStorage,
                sourceId,
                destinationId,
                finalInputsForDestination: mergedInputsMap.get(destinationId) ?? [],
            }));
        }
        if (directlyReloweredNodes.has(nodeKey)) {
            await writer.push(targetStorage.values.delOp(destinationId));
        }

        if (
            decision === 'invalidate' ||
            hostOnlyNodesNeedingInvalidation.has(nodeKey) ||
            reloweringInvalidatedNodes.has(nodeKey)
        ) {
            await writer.push(targetStorage.freshness.putOp(destinationId, 'potentially-outdated'));
            if (initial === 'take') {
                const hostTimestamps = await hostStorage.timestamps.get(sourceId);
                const targetId = targetLookup.keyToId.get(String(nodeKey));
                const targetTimestamps = targetId === undefined
                    ? undefined
                    : await targetStorage.timestamps.get(targetId);
                if (hostTimestamps !== undefined) {
                    await writer.push(targetStorage.timestamps.putOp(destinationId, {
                        createdAt: targetTimestamps?.createdAt ?? hostTimestamps.createdAt,
                        modifiedAt: hostTimestamps.modifiedAt,
                    }));
                }
            }
        }
    }

    for (const [targetIdString, nodeKey] of targetLookup.idToKey.entries()) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (targetId === undefined || String(targetId) !== targetIdString) {
            throw new IdentifierLookupConflictError(`Target lookup is not bijective for ${targetIdString}`);
        }
        if (finalId !== undefined && finalId !== targetId) {
            await writer.pushAll(buildDeleteNodeOps(targetStorage, targetId));
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
 * Persist the final semantic-plan lookup and commit the inactive replica as active.
 * @param {RootDatabase} rootDatabase
 * @param {SchemaStorage} targetStorage
 * @param {ReplicaName} targetReplica
 * @param {IdentifierLookup} finalIdentifierLookup
 * @param {number} targetLastNodeIndex
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
 * - If the merge changed graph data or reconciled identifiers, the inactive
 *   replica contains the merged graph and is made active.
 * - If every node and identifier was kept, the active replica pointer is unchanged. The
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
    assertNoIdentifierCollisions(targetLookup, hostLookup);
    await assertLookupCoversMaterializedNodes(hostStorage, hostLookup, 'staged host snapshot');
    await assertLookupCoversMaterializedNodes(targetStorage, targetLookup, 'merge target replica');

    const targetLastNodeIndex = rootDatabase.getLastNodeIndex();

    const {
        initialDecisions,
        mergedInputsMap,
        decisions,
        hOnlyNeedsInvalidate,
        directlyReloweredNodes,
        reloweringInvalidatedNodes,
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
        hOnlyNeedsInvalidate,
        directlyReloweredNodes,
        reloweringInvalidatedNodes,
        finalIdentifierForKey,
        mergedInputsMap
    );

    const summary = summarizeDecisions(decisions.values());
    const hasChanges = summary.hasChanges || hasIdentifierReconciliation;
    if (hasChanges) {
        await preserveAndRebuildValidity(
            targetStorage,
            decisions,
            initialDecisions,
            finalIdentifierForKey,
            mergedInputsMap,
            targetLookup
        );
    }
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
