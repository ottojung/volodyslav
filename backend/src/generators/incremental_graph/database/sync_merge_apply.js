const { IdentifierLookupConflictError } = require('./replica_errors');
const { buildDeleteNodeOps, copyNodeOps } = require('./sync_merge_transfer');
const { ReplicaBatchWriter } = require('./sync_merge_validity');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {'keep' | 'take' | 'invalidate' | 'delete'} MergeOutcome */

/**
 * Apply semantic decisions by copying the selected side into the final storage
 * identifier and writing planner-lowered inputs.
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Map<NodeKeyString, 'keep' | 'take'>} selectedSideByKey
 * @param {Map<NodeKeyString, MergeOutcome>} outcomeByKey
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @returns {Promise<void>}
 */
async function applyNodeDecisions(
    targetStorage,
    hostStorage,
    targetLookup,
    hostLookup,
    selectedSideByKey,
    outcomeByKey,
    finalIdentifierForKey
) {
    const writer = new ReplicaBatchWriter(targetStorage);

    for (const [nodeKey, outcome] of outcomeByKey) {
        const initial = selectedSideByKey.get(nodeKey);
        const destinationId = finalIdentifierForKey.get(nodeKey);
        if (initial === undefined) {
            throw new IdentifierLookupConflictError(`Incomplete merge plan for ${String(nodeKey)}`);
        }
        if (outcome === 'delete') {
            const targetId = targetLookup.keyToId.get(String(nodeKey));
            if (targetId !== undefined) {
                await writer.pushAll(buildDeleteNodeOps(targetStorage, targetId));
            }
            continue;
        }
        if (destinationId === undefined) {
            throw new IdentifierLookupConflictError(`Surviving merge plan has no final identifier for ${String(nodeKey)}`);
        }
        const structuralSide = outcome === 'invalidate' ? initial : outcome;
        const useHost = structuralSide === 'take';
        const sourceLookup = useHost ? hostLookup : targetLookup;
        const sourceId = sourceLookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined) throw new IdentifierLookupConflictError(`Missing source identifier for ${String(nodeKey)}`);

        if (!useHost && outcome === 'invalidate' && sourceId === destinationId) {
            await writer.push(targetStorage.freshness.putOp(destinationId, 'potentially-outdated'));
            continue;
        }

        const sourceStorage = useHost ? hostStorage : targetStorage;
        const destinationTimestamp = await targetStorage.timestamps.get(destinationId);
        const sourceTimestamp = await sourceStorage.timestamps.get(sourceId);
        if (sourceTimestamp === undefined) {
            throw new IdentifierLookupConflictError(`Source materialized node ${String(sourceId)} has no timestamps entry`);
        }
        const sourceFreshness = await sourceStorage.freshness.get(sourceId);
        if (sourceFreshness !== 'up-to-date' && sourceFreshness !== 'potentially-outdated') {
            throw new IdentifierLookupConflictError(`Source materialized node ${String(sourceId)} has invalid freshness ${String(sourceFreshness)}`);
        }
        const finalFreshness = outcome === 'invalidate'
            ? 'potentially-outdated'
            : sourceFreshness;
        const finalTimestamps = {
            createdAt: destinationTimestamp?.createdAt ?? sourceTimestamp.createdAt,
            modifiedAt: sourceTimestamp.modifiedAt,
        };

        await writer.pushAll(await copyNodeOps({
            targetStorage,
            sourceStorage,
            sourceId,
            destinationId,
            finalFreshness,
            finalTimestamps,
        }));

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
 * @param {Iterable<[NodeKeyString, MergeOutcome]>} outcomes
 * @param {IdentifierLookup} targetLookup
 * @returns {{ kept: number, taken: number, invalidated: number, deleted: number, hasChanges: boolean }}
 */
function summarizeDecisions(outcomes, targetLookup) {
    const outcomeEntries = Array.from(outcomes);
    let kept = 0;
    let taken = 0;
    let invalidated = 0;
    let deleted = 0;

    for (const [, outcome] of outcomeEntries) {
        if (outcome === 'keep') {
            kept += 1;
        } else if (outcome === 'take') {
            taken += 1;
        } else if (outcome === 'invalidate') {
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
        hasChanges: taken + invalidated > 0 || outcomeEntries.some(([nodeKey, outcome]) => outcome === 'delete' && targetLookup.keyToId.has(String(nodeKey))),
    };
}

module.exports = {
    applyNodeDecisions,
    summarizeDecisions,
};
