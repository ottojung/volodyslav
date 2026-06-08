const { makeDbToDbAdapter, unifyStores } = require('./unification');
const { nodeIdentifierToString } = require('./node_identifier');
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

    // Exclude revdeps: they will be recomputed from mergedInputsMap by
    // unifyRevdeps() after the merge.  Copying them here wastes I/O.
    await unifyStores(makeDbToDbAdapter(src, dst, { excludeSublevels: ['revdeps'] }));

    // One final fsync: all unification writes use sync:false for performance;
    // _rawSync() issues an empty batch with sync:true to durably flush the
    // WAL/database state without mutating any keys.
    await rootDatabase._rawSync();
}

/**
 * Build "take" batch operations that copy a node's full data from H into T.
 * Copies value, freshness, timestamps, inputs, and counters.
 * revdeps are NOT copied here; they are rebuilt from scratch at the end.
 *
 * @param {SchemaStorage} T - Target (inactive) replica storage.
 * @param {SchemaStorage} H - Hostname staging storage.
 * @param {NodeIdentifier} key - Identifier to copy.
 * @returns {Promise<Array<*>>}
 */
async function buildTakeOps(T, H, key) {
    /** @type {Array<*>} */
    const ops = [];

    const hValue = await H.values.get(key);
    if (hValue !== undefined) {
        ops.push(T.values.putOp(key, hValue));
    } else {
        ops.push(T.values.delOp(key));
    }

    const hFreshness = await H.freshness.get(key);
    ops.push(T.freshness.putOp(key, hFreshness !== undefined ? hFreshness : 'potentially-outdated'));

    const hTimestamps = await H.timestamps.get(key);
    if (hTimestamps !== undefined) {
        ops.push(T.timestamps.putOp(key, hTimestamps));
    } else {
        ops.push(T.timestamps.delOp(key));
    }

    const hInputs = await H.inputs.get(key);
    if (hInputs !== undefined) {
        ops.push(T.inputs.putOp(key, {
            inputs: hInputs.inputs,
            inputCounters: hInputs.inputCounters,
        }));
    } else {
        ops.push(T.inputs.delOp(key));
    }

    const hCounter = await H.counters.get(key);
    if (hCounter !== undefined) {
        ops.push(T.counters.putOp(key, hCounter));
    } else {
        ops.push(T.counters.delOp(key));
    }

    return ops;
}

/**
 * Copy a node from sourceStorage to targetStorage, potentially under a
 * different destination identifier, with inputs rewritten to lowered
 * final identifiers.
 *
 * @param {object} opts
 * @param {SchemaStorage} opts.targetStorage
 * @param {SchemaStorage} opts.sourceStorage
 * @param {NodeIdentifier} opts.sourceId
 * @param {NodeIdentifier} opts.destinationId
 * @param {NodeIdentifier[]} opts.finalInputs
 * @returns {Promise<Array<*>>}
 */
async function copyNodeOps({ targetStorage, sourceStorage, sourceId, destinationId, finalInputs }) {
    /** @type {Array<*>} */
    const ops = [];

    const srcValue = await sourceStorage.values.get(sourceId);
    if (srcValue !== undefined) {
        ops.push(targetStorage.values.putOp(destinationId, srcValue));
    } else {
        ops.push(targetStorage.values.delOp(destinationId));
    }

    const srcFreshness = await sourceStorage.freshness.get(sourceId);
    ops.push(targetStorage.freshness.putOp(destinationId, srcFreshness ?? 'potentially-outdated'));

    const srcTimestamps = await sourceStorage.timestamps.get(sourceId);
    if (srcTimestamps !== undefined) {
        ops.push(targetStorage.timestamps.putOp(destinationId, srcTimestamps));
    } else {
        ops.push(targetStorage.timestamps.delOp(destinationId));
    }

    const srcInputs = await sourceStorage.inputs.get(sourceId);
    if (srcInputs !== undefined) {
        ops.push(targetStorage.inputs.putOp(destinationId, {
            inputs: finalInputs.map(id => nodeIdentifierToString(id)),
            inputCounters: srcInputs.inputCounters,
        }));
    } else {
        // Use the provided finalInputs even if source has no inputs record.
        ops.push(targetStorage.inputs.putOp(destinationId, {
            inputs: finalInputs.map(id => nodeIdentifierToString(id)),
            inputCounters: [],
        }));
    }

    const srcCounter = await sourceStorage.counters.get(sourceId);
    if (srcCounter !== undefined) {
        ops.push(targetStorage.counters.putOp(destinationId, srcCounter));
    } else {
        ops.push(targetStorage.counters.delOp(destinationId));
    }

    return ops;
}

/**
 * Build delete operations to remove a losing identifier from all sublevels in
 * the target storage.
 *
 * Revdeps are NOT included here; they are rebuilt from scratch.
 *
 * @param {SchemaStorage} storage
 * @param {NodeIdentifier} key
 * @returns {Array<*>}
 */
function buildDeleteOps(storage, key) {
    return [
        storage.values.delOp(key),
        storage.freshness.delOp(key),
        storage.inputs.delOp(key),
        storage.counters.delOp(key),
        storage.timestamps.delOp(key),
    ];
}

module.exports = {
    buildDeleteOps,
    buildTakeOps,
    copyNodeOps,
    copyReplicaGently,
};
