const { makeDbToDbAdapter, unifyStores } = require('./unification');
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
 * @returns {Promise<Array<*>>}
 */
async function copyNodeOps({
    targetStorage,
    sourceStorage,
    sourceId,
    destinationId,
}) {
    /** @type {Array<*>} */
    const ops = [];
    const sourceValue = await sourceStorage.values.get(sourceId);
    ops.push(sourceValue === undefined
        ? targetStorage.values.delOp(destinationId)
        : targetStorage.values.putOp(destinationId, sourceValue));

    const sourceFreshness = await sourceStorage.freshness.get(sourceId);
    ops.push(targetStorage.freshness.putOp(
        destinationId,
        sourceValue === undefined ? 'missing' : (sourceFreshness ?? 'potentially-outdated')
    ));

    const sourceTimestamps = await sourceStorage.timestamps.get(sourceId);
    if (sourceTimestamps === undefined) {
        const nowIso = "1970-01-01T00:00:00.000Z";
        ops.push(targetStorage.timestamps.putOp(destinationId, { createdAt: nowIso, modifiedAt: nowIso }));
    } else {
        ops.push(targetStorage.timestamps.putOp(destinationId, sourceTimestamps));
    }
    return ops;
}

module.exports = { buildDeleteNodeOps, copyNodeOps, copyReplicaGently };
