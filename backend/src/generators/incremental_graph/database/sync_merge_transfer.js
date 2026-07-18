const { makeDbToDbAdapter, unifyStores } = require('./unification');
const { ReplicaStateInvariantError } = require('./sync_merge_validation');
const { nodeIdentifierToString } = require('./types');
/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./root_database').ReplicaName} ReplicaName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * @param {RootDatabase} rootDatabase
 * @param {ReplicaName} from
 * @param {ReplicaName} to
 * @returns {Promise<void>}
 */
async function copyReplicaGently(rootDatabase, from, to) {
    const src = rootDatabase.schemaStorageForReplica(from);
    const dst = rootDatabase.schemaStorageForReplica(to);
    await unifyStores(makeDbToDbAdapter(src, dst));
    await rootDatabase._rawSync();
}

/**
 * Build operations that remove every primary record for a discarded identifier.
 * @param {SchemaStorage} targetStorage
 * @param {NodeIdentifier} identifier
 * @returns {Array<*>}
 */
function buildDeleteNodeOps(targetStorage, identifier) {
    return [
        targetStorage.values.delOp(identifier),
        targetStorage.freshness.delOp(identifier),
        targetStorage.valid.delOp(identifier),
        targetStorage.timestamps.delOp(identifier),
    ];
}

/**
 * Build operations that copy a node between potentially different identifiers.
 * Validity is not copied here — it is rebuilt by the caller from scheme-derived
 * edges by provenance-aware validity reconstruction.
 *
 * @param {object} options
 * @param {SchemaStorage} options.targetStorage
 * @param {SchemaStorage} options.sourceStorage
 * @param {NodeIdentifier} options.sourceId
 * @param {NodeIdentifier} options.destinationId
 * @param {{createdAt: string, modifiedAt: string}} options.sourceTimestamps - Already-read timestamps for sourceId; the caller must have verified this is defined.
 * @returns {Promise<Array<*>>}
 */
async function copyNodeOps({
    targetStorage,
    sourceStorage,
    sourceId,
    destinationId,
    sourceTimestamps,
}) {
    /** @type {Array<*>} */
    const ops = [];
    const sourceValue = await sourceStorage.values.get(sourceId);
    if (sourceValue === undefined) {
        throw new ReplicaStateInvariantError('sync merge copy', 'has no cached value', nodeIdentifierToString(sourceId));
    }
    ops.push(targetStorage.values.putOp(destinationId, sourceValue));

    const sourceFreshness = await sourceStorage.freshness.get(sourceId);
    if (sourceFreshness !== 'up-to-date' && sourceFreshness !== 'potentially-outdated') {
        throw new ReplicaStateInvariantError('sync merge copy', `has invalid freshness ${String(sourceFreshness)}`, nodeIdentifierToString(sourceId));
    }
    ops.push(targetStorage.freshness.putOp(destinationId, sourceFreshness));

    if (sourceTimestamps === undefined) {
        throw new ReplicaStateInvariantError('sync merge copy', 'has no timestamps entry', nodeIdentifierToString(sourceId));
    }
    ops.push(targetStorage.timestamps.putOp(destinationId, sourceTimestamps));
    return ops;
}

module.exports = { buildDeleteNodeOps, copyNodeOps, copyReplicaGently };
