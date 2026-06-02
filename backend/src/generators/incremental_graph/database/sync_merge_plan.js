const { topologicalSortFromMap } = require('./topo_sort');
const { compareIsoTimestamps } = require('./sync_merge_timestamps');
const { stringToNodeIdentifier } = require('./types');

/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * Compute merged graph inputs and final node decisions for host merge.
 *
 * @param {SchemaStorage} T
 * @param {SchemaStorage} H
 * @param {(targetIdentifier: NodeIdentifier) => NodeIdentifier} hostIdentifierForTargetIdentifier
 * @param {(record: import('./root_database').InputsRecord | undefined) => NodeIdentifier[]} translatedHostInputs
 * @returns {Promise<{
 *   initialDecisions: Map<NodeIdentifier, 'keep' | 'take'>,
 *   mergedInputsMap: Map<NodeIdentifier, NodeIdentifier[]>,
 *   decisions: Map<NodeIdentifier, 'keep' | 'take' | 'invalidate'>,
 *   hOnlyNeedsInvalidate: Set<NodeIdentifier>
 * }>}
 */
async function buildMergePlan(T, H, hostIdentifierForTargetIdentifier, translatedHostInputs) {
    /** @type {Map<NodeIdentifier, 'keep' | 'take'>} */
    const initialDecisions = new Map();
    /** @type {Set<NodeIdentifier>} */
    const forceKeepRoots = new Set();
    /** @type {Set<NodeIdentifier>} */
    const forceTakeRoots = new Set();

    for await (const node of T.inputs.keys()) {
        const tTimestamps = await T.timestamps.get(node);
        const hTimestamps = await H.timestamps.get(hostIdentifierForTargetIdentifier(node));

        const cmp = compareIsoTimestamps(tTimestamps?.modifiedAt, hTimestamps?.modifiedAt);

        if (hTimestamps === undefined || cmp >= 0) {
            initialDecisions.set(node, 'keep');
            if (cmp > 0) {
                forceKeepRoots.add(node);
            }
        } else {
            initialDecisions.set(node, 'take');
            forceTakeRoots.add(node);
        }
    }

    /** @type {Set<NodeIdentifier>} */
    const hOnlyNodes = new Set();
    for await (const hostKey of H.inputs.keys()) {
        if (!initialDecisions.has(hostKey)) {
            hOnlyNodes.add(hostKey);
        }
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const mergedInputsMap = new Map();

    for (const [node, decision] of initialDecisions) {
        if (decision === 'take') {
            const record = await H.inputs.get(hostIdentifierForTargetIdentifier(node));
            mergedInputsMap.set(node, translatedHostInputs(record));
        } else {
            const record = await T.inputs.get(node);
            const inputKeys = record
                ? record.inputs.map(input => stringToNodeIdentifier(input))
                : [];
            mergedInputsMap.set(node, inputKeys);
        }
    }

    for (const key of hOnlyNodes) {
        const record = await H.inputs.get(hostIdentifierForTargetIdentifier(key));
        mergedInputsMap.set(key, translatedHostInputs(record));
    }

    const topoList = topologicalSortFromMap(mergedInputsMap);

    /** @type {Set<NodeIdentifier>} */
    const keepTainted = new Set(forceKeepRoots);
    /** @type {Set<NodeIdentifier>} */
    const takeTainted = new Set(forceTakeRoots);

    for (const node of topoList) {
        const inputKeys = mergedInputsMap.get(node) ?? [];
        for (const inputKey of inputKeys) {
            if (keepTainted.has(inputKey)) keepTainted.add(node);
            if (takeTainted.has(inputKey)) takeTainted.add(node);
        }
    }

    /** @type {Map<NodeIdentifier, 'keep' | 'take' | 'invalidate'>} */
    const decisions = new Map();

    for (const [node, initial] of initialDecisions) {
        const inKeep = keepTainted.has(node);
        const inTake = takeTainted.has(node);

        if (inKeep && inTake) {
            decisions.set(node, 'invalidate');
        } else if (inKeep) {
            decisions.set(node, 'keep');
        } else if (inTake) {
            decisions.set(node, 'take');
        } else {
            decisions.set(node, initial);
        }
    }

    /** @type {Set<NodeIdentifier>} */
    const hOnlyNeedsInvalidate = new Set();
    for (const key of hOnlyNodes) {
        decisions.set(key, 'take');
        if (keepTainted.has(key)) {
            hOnlyNeedsInvalidate.add(key);
        }
    }

    return {
        initialDecisions,
        mergedInputsMap,
        decisions,
        hOnlyNeedsInvalidate,
    };
}

module.exports = {
    buildMergePlan,
};
