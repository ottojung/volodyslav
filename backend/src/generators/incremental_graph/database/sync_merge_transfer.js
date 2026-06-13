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
    await unifyStores(makeDbToDbAdapter(src, dst, { excludeSublevels: ['revdeps'] }));
    await rootDatabase._rawSync();
}

/**
 * Build operations that remove every primary record for a discarded identifier.
 * Reverse dependencies are rebuilt from the final lowered graph.
 * @param {SchemaStorage} targetStorage
 * @param {NodeIdentifier} identifier
 * @returns {Array<*>}
 */
function buildDeleteNodeOps(targetStorage, identifier) {
    return [
        targetStorage.values.delOp(identifier),
        targetStorage.freshness.delOp(identifier),
        targetStorage.inputs.delOp(identifier),
        targetStorage.counters.delOp(identifier),
        targetStorage.timestamps.delOp(identifier),
    ];
}

/**
 * Build operations that copy a node between potentially different identifiers.
 * Inputs are supplied by the semantic planner after lowering to final identifiers.
 *
 * `inputCounters` describe the source computation and are copied only as
 * historical dependency metadata. If lowering changes any input identifier,
 * the caller must delete the copied value and mark the node outdated so these
 * counters can never authorize reuse of a value computed against another
 * storage identity.
 *
 * @param {object} options
 * @param {SchemaStorage} options.targetStorage
 * @param {SchemaStorage} options.sourceStorage
 * @param {NodeIdentifier} options.sourceId
 * @param {NodeIdentifier} options.destinationId
 * @param {NodeIdentifier[]} options.finalInputsForDestination
 * @returns {Promise<Array<*>>}
 */
async function copyNodeOps({
    targetStorage,
    sourceStorage,
    sourceId,
    destinationId,
    finalInputsForDestination,
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
        sourceFreshness ?? 'potentially-outdated'
    ));

    const sourceTimestamps = await sourceStorage.timestamps.get(sourceId);
    ops.push(sourceTimestamps === undefined
        ? targetStorage.timestamps.delOp(destinationId)
        : targetStorage.timestamps.putOp(destinationId, sourceTimestamps));

    const sourceInputs = await sourceStorage.inputs.get(sourceId);
    ops.push(sourceInputs === undefined
        ? targetStorage.inputs.delOp(destinationId)
        : targetStorage.inputs.putOp(destinationId, finalInputsForDestination));

    const sourceCounter = await sourceStorage.counters.get(sourceId);
    ops.push(sourceCounter === undefined
        ? targetStorage.counters.delOp(destinationId)
        : targetStorage.counters.putOp(destinationId, sourceCounter));
    return ops;
}

module.exports = { buildDeleteNodeOps, copyNodeOps, copyReplicaGently };
