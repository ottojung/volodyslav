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

module.exports = {
    buildTakeOps,
    copyReplicaGently,
};
