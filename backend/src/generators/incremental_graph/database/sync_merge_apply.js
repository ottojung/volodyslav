const { IdentifierLookupConflictError } = require('./replica_errors');
const { buildDeleteNodeOps, copyNodeOps } = require('./sync_merge_transfer');
const { ReplicaBatchWriter } = require('./sync_merge_validity');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {'keep' | 'take' | 'invalidate' | 'delete'} MergeDecision */

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
 * @param {Set<NodeKeyString>} equalVersionNeedsInvalidation
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
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
    equalVersionNeedsInvalidation,
    finalIdentifierForKey
) {
    const writer = new ReplicaBatchWriter(targetStorage);

    for (const [nodeKey, decision] of decisions) {
        const initial = initialDecisions.get(nodeKey);
        const destinationId = finalIdentifierForKey.get(nodeKey);
        if (initial === undefined) {
            throw new IdentifierLookupConflictError(`Incomplete merge plan for ${String(nodeKey)}`);
        }
        if (decision === 'delete') {
            const targetId = targetLookup.keyToId.get(String(nodeKey));
            if (targetId !== undefined) {
                await writer.pushAll(buildDeleteNodeOps(targetStorage, targetId));
            }
            continue;
        }
        if (destinationId === undefined) {
            throw new IdentifierLookupConflictError(`Surviving merge plan has no final identifier for ${String(nodeKey)}`);
        }
        const structuralSide = decision === 'invalidate' ? initial : decision;
        const useHost = structuralSide === 'take';
        const sourceLookup = useHost ? hostLookup : targetLookup;
        const sourceId = sourceLookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined) throw new IdentifierLookupConflictError(`Missing source identifier for ${String(nodeKey)}`);

        if (!useHost && decision === 'keep' && sourceId === destinationId) {
            if (equalVersionNeedsInvalidation.has(nodeKey)) {
                await writer.push(targetStorage.freshness.putOp(destinationId, 'potentially-outdated'));
            }
            continue;
        }

        if (!useHost && decision === 'invalidate' && sourceId === destinationId) {
            await writer.push(targetStorage.freshness.putOp(destinationId, 'potentially-outdated'));
            continue;
        }

        const sourceStorage = useHost ? hostStorage : targetStorage;
        const destinationTimestamp = await targetStorage.timestamps.get(destinationId);
        const sourceTimestamp = await sourceStorage.timestamps.get(sourceId);
        if (sourceTimestamp === undefined) {
            throw new IdentifierLookupConflictError(`Source materialized node ${String(sourceId)} has no timestamps entry`);
        }

        await writer.pushAll(await copyNodeOps({
            targetStorage,
            sourceStorage,
            sourceId,
            destinationId,
            sourceTimestamps: sourceTimestamp,
        }));
        await writer.push(targetStorage.timestamps.putOp(destinationId, {
            createdAt: destinationTimestamp?.createdAt ?? sourceTimestamp.createdAt,
            modifiedAt: sourceTimestamp.modifiedAt,
        }));
        if (
            decision === 'invalidate' ||
            hostOnlyNodesNeedingInvalidation.has(nodeKey) ||
            equalVersionNeedsInvalidation.has(nodeKey)
        ) {
            await writer.push(targetStorage.freshness.putOp(destinationId, 'potentially-outdated'));
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
 * @param {Iterable<[NodeKeyString, MergeDecision]>} decisions
 * @param {IdentifierLookup} targetLookup
 * @returns {{ kept: number, taken: number, invalidated: number, deleted: number, hasChanges: boolean }}
 */
function summarizeDecisions(decisions, targetLookup) {
    const decisionEntries = Array.from(decisions);
    let kept = 0;
    let taken = 0;
    let invalidated = 0;
    let deleted = 0;

    for (const [, decision] of decisionEntries) {
        if (decision === 'keep') {
            kept += 1;
        } else if (decision === 'take') {
            taken += 1;
        } else if (decision === 'invalidate') {
            invalidated += 1;
        } else {
            deleted += 1;
        }
    }

    return {
        kept,
        taken,
        invalidated,
        deleted,
        hasChanges: taken + invalidated > 0 || decisionEntries.some(([nodeKey, decision]) => decision === 'delete' && targetLookup.keyToId.has(String(nodeKey))),
    };
}

module.exports = {
    applyNodeDecisions,
    summarizeDecisions,
};
