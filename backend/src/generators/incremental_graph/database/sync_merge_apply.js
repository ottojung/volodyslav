const { IdentifierLookupConflictError } = require('./replica_errors');
const { buildDeleteNodeOps, copyNodeOps } = require('./sync_merge_transfer');
const { ReplicaBatchWriter } = require('./sync_merge_validity');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {'keep' | 'take' | 'invalidate'} MergeDecision */

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
    directlyReloweredNodes,
    reloweringInvalidatedNodes,
    equalVersionNeedsInvalidation,
    finalIdentifierForKey
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
        const destinationTimestamp = await targetStorage.timestamps.get(destinationId);
        const sourceTimestamp = await sourceStorage.timestamps.get(sourceId);
        if (sourceTimestamp === undefined) {
            throw new IdentifierLookupConflictError(`Source materialized node ${String(sourceId)} has no timestamps entry`);
        }

        if (shouldCopy) {
            await writer.pushAll(await copyNodeOps({
                targetStorage,
                sourceStorage,
                sourceId,
                destinationId,
            }));
            await writer.push(targetStorage.timestamps.putOp(destinationId, {
                createdAt: destinationTimestamp?.createdAt ?? sourceTimestamp.createdAt,
                modifiedAt: sourceTimestamp.modifiedAt,
            }));
        }
        if (directlyReloweredNodes.has(nodeKey)) {
            await writer.push(targetStorage.values.delOp(destinationId));
            await writer.push(targetStorage.freshness.putOp(destinationId, 'missing'));
            await writer.push(targetStorage.valid.delOp(destinationId));
            await writer.push(targetStorage.timestamps.putOp(destinationId, {
                createdAt: destinationTimestamp?.createdAt ?? sourceTimestamp.createdAt,
                modifiedAt: sourceTimestamp.modifiedAt,
            }));
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

        const destinationHasCachedValue = shouldCopy
            ? await sourceStorage.values.get(sourceId) !== undefined && !directlyReloweredNodes.has(nodeKey)
            : await targetStorage.values.get(destinationId) !== undefined;
        if (!destinationHasCachedValue) {
            await writer.push(targetStorage.freshness.putOp(destinationId, 'missing'));
            await writer.push(targetStorage.valid.delOp(destinationId));
        }
        if (destinationTimestamp === undefined && !shouldCopy) {
            throw new IdentifierLookupConflictError(`Destination materialized node ${String(destinationId)} has no timestamps entry`);
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

    // Equal-version freshness: when both sides have the same modifiedAt but
    // either side is not up-to-date, the merged node must not be up-to-date.
    // Set freshness to potentially-outdated without changing the timestamp.
    for (const nodeKey of equalVersionNeedsInvalidation) {
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId !== undefined) {
            const hasValue = await targetStorage.values.get(finalId);
            if (hasValue !== undefined) {
                const currentFreshness = await targetStorage.freshness.get(finalId);
                if (currentFreshness === 'up-to-date') {
                    await writer.push(targetStorage.freshness.putOp(finalId, 'potentially-outdated'));
                }
            }
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

module.exports = {
    applyNodeDecisions,
    summarizeDecisions,
};
