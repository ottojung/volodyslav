const { IdentifierLookupConflictError } = require('./replica_errors');
const { buildDeleteNodeOps, copyNodeOps } = require('./sync_merge_transfer');
const { ReplicaBatchWriter } = require('./sync_merge_validity');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {'keep' | 'take'} SourceSelection */

/**
 * Apply source selection, structural survival, and hard invalidation as
 * independent merge outcomes.
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} hostStorage
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Map<NodeKeyString, SourceSelection>} selectedSourceByKey
 * @param {Set<NodeKeyString>} directInvalidationKeys
 * @param {Set<NodeKeyString>} deletedMaterializationKeys
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @returns {Promise<void>}
 */
async function applyNodeDecisions(
    targetStorage,
    hostStorage,
    targetLookup,
    hostLookup,
    selectedSourceByKey,
    directInvalidationKeys,
    deletedMaterializationKeys,
    finalIdentifierForKey
) {
    const writer = new ReplicaBatchWriter(targetStorage);

    for (const [nodeKey, sourceSelection] of selectedSourceByKey) {
        if (deletedMaterializationKeys.has(nodeKey)) {
            const targetId = targetLookup.keyToId.get(String(nodeKey));
            if (targetId !== undefined) {
                await writer.pushAll(buildDeleteNodeOps(targetStorage, targetId));
            }
            continue;
        }

        const destinationId = finalIdentifierForKey.get(nodeKey);
        if (destinationId === undefined) {
            throw new IdentifierLookupConflictError(`Surviving merge plan has no final identifier for ${String(nodeKey)}`);
        }
        const useHost = sourceSelection === 'take';
        const sourceLookup = useHost ? hostLookup : targetLookup;
        const sourceId = sourceLookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined) throw new IdentifierLookupConflictError(`Missing source identifier for ${String(nodeKey)}`);

        const finalFreshnessOverride = directInvalidationKeys.has(nodeKey) ? 'potentially-outdated' : undefined;
        if (!useHost && sourceId === destinationId) {
            if (finalFreshnessOverride !== undefined) {
                await writer.push(targetStorage.freshness.putOp(destinationId, finalFreshnessOverride));
            }
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
        const finalTimestamps = {
            createdAt: destinationTimestamp?.createdAt ?? sourceTimestamp.createdAt,
            modifiedAt: sourceTimestamp.modifiedAt,
        };

        await writer.pushAll(await copyNodeOps({
            targetStorage,
            sourceStorage,
            sourceId,
            destinationId,
            finalFreshness: finalFreshnessOverride ?? sourceFreshness,
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
 * Merge-summary counts are graph outcomes, not mutually exclusive decisions.
 * A host-sourced node that is also a hard-invalidation root counts as both
 * taken and invalidated.
 * @param {object} options
 * @param {Map<NodeKeyString, SourceSelection>} options.selectedSourceByKey
 * @param {Set<NodeKeyString>} options.directInvalidationKeys
 * @param {Set<NodeKeyString>} options.deletedMaterializationKeys
 * @param {IdentifierLookup} options.targetLookup
 * @returns {{ kept: number, taken: number, invalidated: number, deleted: number, hasChanges: boolean }}
 */
function summarizeDecisions({
    selectedSourceByKey,
    directInvalidationKeys,
    deletedMaterializationKeys,
    targetLookup,
}) {
    let kept = 0;
    let taken = 0;
    for (const sourceSelection of selectedSourceByKey.values()) {
        if (sourceSelection === 'take') taken += 1;
        else kept += 1;
    }
    const deleted = deletedMaterializationKeys.size;
    const invalidated = directInvalidationKeys.size;
    return {
        kept,
        taken,
        invalidated,
        deleted,
        hasChanges: taken > 0
            || invalidated > 0
            || Array.from(deletedMaterializationKeys).some(nodeKey => targetLookup.keyToId.has(String(nodeKey))),
    };
}

module.exports = {
    applyNodeDecisions,
    summarizeDecisions,
};
