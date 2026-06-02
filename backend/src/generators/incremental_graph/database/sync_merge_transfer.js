const { makeDbToDbAdapter, unifyStores } = require('./unification');
const { stringToNodeIdentifier } = require('./types');
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
 * @param {NodeIdentifier} targetKey - Identifier to write in the target replica.
 * @param {NodeIdentifier} hostKey - Identifier to read from the host staging storage.
 * @param {(hostIdentifier: NodeIdentifier) => NodeIdentifier} targetIdentifierForHostIdentifier
 * @returns {Promise<Array<*>>}
 */
async function buildTakeOps(T, H, targetKey, hostKey, targetIdentifierForHostIdentifier) {
    /** @type {Array<*>} */
    const ops = [];

    const hValue = await H.values.get(hostKey);
    if (hValue !== undefined) {
        ops.push(T.values.putOp(targetKey, hValue));
    } else {
        ops.push(T.values.delOp(targetKey));
    }

    const hFreshness = await H.freshness.get(hostKey);
    ops.push(T.freshness.putOp(targetKey, hFreshness !== undefined ? hFreshness : 'potentially-outdated'));

    const hTimestamps = await H.timestamps.get(hostKey);
    if (hTimestamps !== undefined) {
        ops.push(T.timestamps.putOp(targetKey, hTimestamps));
    } else {
        ops.push(T.timestamps.delOp(targetKey));
    }

    const hInputs = await H.inputs.get(hostKey);
    if (hInputs !== undefined) {
        ops.push(T.inputs.putOp(targetKey, {
            inputs: hInputs.inputs.map(input => nodeIdentifierToString(targetIdentifierForHostIdentifier(stringToNodeIdentifier(input)))),
            inputCounters: hInputs.inputCounters,
        }));
    } else {
        ops.push(T.inputs.delOp(targetKey));
    }

    const hCounter = await H.counters.get(hostKey);
    if (hCounter !== undefined) {
        ops.push(T.counters.putOp(targetKey, hCounter));
    } else {
        ops.push(T.counters.delOp(targetKey));
    }

    return ops;
}

module.exports = {
    buildTakeOps,
    copyReplicaGently,
};
