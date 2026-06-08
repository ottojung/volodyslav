const { compareIsoTimestamps } = require('./sync_merge_timestamps');
const { stringToNodeIdentifier, stringToNodeKeyString, nodeKeyStringToString } = require('./types');
const { nodeIdentifierToString } = require('./node_identifier');
const { TopologicalSortCycleError } = require('./topo_sort');
const { MissingInputIdentifierError } = require('./replica_errors');

/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {'keep' | 'take' | 'invalidate'} MergeDecision */

/**
 * @typedef {object} SemanticMergeInfo
 * @property {NodeKeyString} nodeKey
 * @property {NodeIdentifier | undefined} targetId
 * @property {NodeIdentifier | undefined} hostId
 */

/**
 * @typedef {object} MergePlanResult
 * @property {Map<NodeKeyString, MergeDecision>} decisions
 * @property {Map<NodeKeyString, 'keep' | 'take'>} initialDecisions
 * @property {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @property {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @property {Set<NodeIdentifier>} hOnlyNeedsInvalidate
 * @property {boolean} identifierChanges
 */

/**
 * Compute merged graph inputs and final node decisions for host merge.
 * Operates over semantic node keys, not raw identifiers.
 *
 * @param {SchemaStorage} T
 * @param {SchemaStorage} H
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @returns {Promise<MergePlanResult>}
 */
async function buildMergePlan(T, H, targetLookup, hostLookup) {
    /** @type {Map<NodeKeyString, SemanticMergeInfo>} */
    const semanticInfo = new Map();

    // Build unified semantic-key view from both lookups.
    for (const [nodeKeyString, targetId] of targetLookup.keyToId.entries()) {
        const key = stringToNodeKeyString(nodeKeyString);
        semanticInfo.set(key, {
            nodeKey: key,
            targetId,
            hostId: hostLookup.keyToId.get(nodeKeyString),
        });
    }
    for (const [nodeKeyString, hostId] of hostLookup.keyToId.entries()) {
        const key = stringToNodeKeyString(nodeKeyString);
        if (!semanticInfo.has(key)) {
            semanticInfo.set(key, {
                nodeKey: key,
                targetId: undefined,
                hostId,
            });
        }
    }

    /** @type {Set<NodeKeyString>} */
    const targetOnlyKeys = new Set();
    /** @type {Set<NodeKeyString>} */
    const sharedKeys = new Set();

    // Phase 1: Timestamp comparison at the semantic-key level.
    /** @type {Map<NodeKeyString, 'keep' | 'take'>} */
    const initialDecisions = new Map();
    /** @type {Set<NodeKeyString>} */
    const forceKeepRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const forceTakeRoots = new Set();

    for (const [, info] of semanticInfo) {
        if (info.targetId !== undefined && info.hostId !== undefined) {
            sharedKeys.add(info.nodeKey);
            // Shared node: compare timestamps.
            const tTimestamps = await T.timestamps.get(info.targetId);
            const hTimestamps = await H.timestamps.get(info.hostId);
            const cmp = compareIsoTimestamps(tTimestamps?.modifiedAt, hTimestamps?.modifiedAt);

            if (hTimestamps === undefined || cmp >= 0) {
                initialDecisions.set(info.nodeKey, 'keep');
                if (cmp > 0) {
                    forceKeepRoots.add(info.nodeKey);
                }
            } else {
                initialDecisions.set(info.nodeKey, 'take');
                forceTakeRoots.add(info.nodeKey);
            }
        } else if (info.targetId !== undefined) {
            // Target-only node.
            initialDecisions.set(info.nodeKey, 'keep');
            targetOnlyKeys.add(info.nodeKey);
        }
        // Host-only nodes (info.hostId !== undefined, info.targetId === undefined)
        // are handled separately below.
    }

    /** @type {Set<NodeKeyString>} */
    const hOnlyNodes = new Set();
    for (const [, info] of semanticInfo) {
        if (info.targetId === undefined && info.hostId !== undefined) {
            hOnlyNodes.add(info.nodeKey);
        }
    }

    // Phase 2: Build merged dependency graph at the semantic-key level.
    // Use the "winner side"'s input identifiers, then map through that side's lookup.
    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const semanticMergedInputs = new Map();

    for (const [, info] of semanticInfo) {
        if (info.targetId !== undefined && info.hostId !== undefined) {
            const initialDecision = initialDecisions.get(info.nodeKey);
            if (initialDecision === 'take') {
                const record = await H.inputs.get(info.hostId);
                const inputIds = record
                    ? record.inputs.map(input => stringToNodeIdentifier(input))
                    : [];
                semanticMergedInputs.set(info.nodeKey, mapInputIdsToKeys(
                    inputIds, hostLookup, 'host lookup'
                ));
            } else if (initialDecision === 'keep') {
                const record = await T.inputs.get(info.targetId);
                const inputIds = record
                    ? record.inputs.map(input => stringToNodeIdentifier(input))
                    : [];
                semanticMergedInputs.set(info.nodeKey, mapInputIdsToKeys(
                    inputIds, targetLookup, 'target lookup'
                ));
            }
        } else if (info.targetId !== undefined) {
            // Target-only node.
            const record = await T.inputs.get(info.targetId);
            const inputIds = record
                ? record.inputs.map(input => stringToNodeIdentifier(input))
                : [];
            semanticMergedInputs.set(info.nodeKey, mapInputIdsToKeys(
                inputIds, targetLookup, 'target lookup'
            ));
        } else if (info.hostId !== undefined) {
            // Host-only node.
            const record = await H.inputs.get(info.hostId);
            const inputIds = record
                ? record.inputs.map(input => stringToNodeIdentifier(input))
                : [];
            semanticMergedInputs.set(info.nodeKey, mapInputIdsToKeys(
                inputIds, hostLookup, 'host lookup'
            ));
        }
    }

    // Phase 3: Topological sort over semantic keys using string comparison.
    const topoList = topologicalSortFromMapStrings(semanticMergedInputs);

    // Phase 4: Taint propagation over semantic keys.
    /** @type {Set<NodeKeyString>} */
    const keepTainted = new Set(forceKeepRoots);
    /** @type {Set<NodeKeyString>} */
    const takeTainted = new Set(forceTakeRoots);

    for (const nodeKey of topoList) {
        const inputKeys = semanticMergedInputs.get(nodeKey) ?? [];
        for (const inputKey of inputKeys) {
            if (keepTainted.has(inputKey)) keepTainted.add(nodeKey);
            if (takeTainted.has(inputKey)) takeTainted.add(nodeKey);
        }
    }

    // Phase 5: Produce final decisions keyed by semantic key.
    /** @type {Map<NodeKeyString, MergeDecision>} */
    const decisions = new Map();

    for (const [nodeKey, initial] of initialDecisions) {
        const inKeep = keepTainted.has(nodeKey);
        const inTake = takeTainted.has(nodeKey);

        if (inKeep && inTake) {
            decisions.set(nodeKey, 'invalidate');
        } else if (inKeep) {
            decisions.set(nodeKey, 'keep');
        } else if (inTake) {
            decisions.set(nodeKey, 'take');
        } else {
            decisions.set(nodeKey, initial);
        }
    }

    /** @type {Set<NodeKeyString>} */
    const hOnlyNeedsInvalidateKeys = new Set();
    for (const key of hOnlyNodes) {
        decisions.set(key, 'take');
        if (keepTainted.has(key)) {
            hOnlyNeedsInvalidateKeys.add(key);
        }
    }

    // Target-only nodes must remain 'keep' regardless of taint: they have no
    // host-side counterpart, so 'take' would attempt to copy from non-existent
    // host storage, and 'invalidate' would discard the only copy of data.
    for (const key of targetOnlyKeys) {
        decisions.set(key, 'keep');
    }

    // Phase 6: Build final identifier for every semantic key.
    /** @type {Map<NodeKeyString, NodeIdentifier>} */
    const finalIdentifierForKey = new Map();
    /** @type {boolean} */
    let identifierChanges = false;

    for (const [, info] of semanticInfo) {
        // Any key with different identifiers on both sides is an identifier change.
        if (info.targetId !== undefined && info.hostId !== undefined && info.targetId !== info.hostId) {
            identifierChanges = true;
        }

        const decision = decisions.get(info.nodeKey);
        if (decision === 'take') {
            if (info.hostId !== undefined) {
                finalIdentifierForKey.set(info.nodeKey, info.hostId);
            }
        } else if (decision === 'invalidate') {
            // Invalidate uses the initial side's identifier.
            const initial = initialDecisions.get(info.nodeKey);
            if (initial === 'take' && info.hostId !== undefined) {
                finalIdentifierForKey.set(info.nodeKey, info.hostId);
            } else if (info.targetId !== undefined) {
                finalIdentifierForKey.set(info.nodeKey, info.targetId);
            }
        } else {
            // keep or no decision (target-only, host-only with initial keep)
            if (info.targetId !== undefined) {
                finalIdentifierForKey.set(info.nodeKey, info.targetId);
            } else if (info.hostId !== undefined) {
                // Host-only node
                finalIdentifierForKey.set(info.nodeKey, info.hostId);
            }
        }
    }

    // Ensure every key in the semantic-info has a final identifier.
    for (const [, info] of semanticInfo) {
        if (!finalIdentifierForKey.has(info.nodeKey)) {
            if (info.targetId !== undefined) {
                finalIdentifierForKey.set(info.nodeKey, info.targetId);
            } else if (info.hostId !== undefined) {
                finalIdentifierForKey.set(info.nodeKey, info.hostId);
            }
        }
    }

    // Phase 7: Lower semanticMergedInputs to final identifier-keyed mergedInputsMap.
    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const mergedInputsMap = new Map();
    for (const [nodeKey, inputKeys] of semanticMergedInputs) {
        const finalNodeId = finalIdentifierForKey.get(nodeKey);
        if (finalNodeId === undefined) continue;

        /** @type {NodeIdentifier[]} */
        const finalInputIds = [];
        for (const inputKey of inputKeys) {
            const finalInputId = finalIdentifierForKey.get(inputKey);
            if (finalInputId !== undefined) {
                finalInputIds.push(finalInputId);
            }
        }
        mergedInputsMap.set(finalNodeId, finalInputIds);
    }

    // Phase 8: Lower hOnlyNeedsInvalidate to final identifiers.
    /** @type {Set<NodeIdentifier>} */
    const hOnlyNeedsInvalidate = new Set();
    for (const nodeKey of hOnlyNeedsInvalidateKeys) {
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId !== undefined) {
            hOnlyNeedsInvalidate.add(finalId);
        }
    }

    return {
        initialDecisions,
        mergedInputsMap,
        decisions,
        finalIdentifierForKey,
        hOnlyNeedsInvalidate,
        identifierChanges,
    };
}

/**
 * Map a node identifier to its semantic node key string.
 * @param {IdentifierLookup} lookup
 * @param {NodeIdentifier} id
 * @returns {NodeKeyString | undefined}
 */
function idToNodeKey(lookup, id) {
    const idStr = nodeIdentifierToString(id);
    return lookup.idToKey.get(idStr) ?? undefined;
}

/**
 * Map an array of input identifiers to semantic node keys, throwing on any
 * missing identifier instead of silently dropping it.
 * @param {NodeIdentifier[]} inputIds
 * @param {IdentifierLookup} lookup
 * @param {string} context - Human-readable context for error messages.
 * @returns {NodeKeyString[]}
 * @throws {MissingInputIdentifierError}
 */
function mapInputIdsToKeys(inputIds, lookup, context) {
    return inputIds.map(id => {
        const key = idToNodeKey(lookup, id);
        if (key === undefined) {
            throw new MissingInputIdentifierError(
                nodeIdentifierToString(id),
                context
            );
        }
        return key;
    });
}

/**
 * Lexicographic string comparison for semantic keys.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareNodeKeyStrings(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Topological sort over a map keyed by NodeKeyString values.
 * Uses lexicographic string ordering to replace compareNodeIdentifier.
 * @param {Map<NodeKeyString, NodeKeyString[]>} inputsMap
 * @returns {NodeKeyString[]}
 */
function topologicalSortFromMapStrings(inputsMap) {
    const allNodes = [...inputsMap.keys()];

    if (allNodes.length === 0) {
        return [];
    }

    // Build: inDegree map and adjacency list.
    /** @type {Map<NodeKeyString, number>} */
    const inDegree = new Map();
    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const dependents = new Map();

    for (const node of allNodes) {
        if (!inDegree.has(node)) {
            inDegree.set(node, 0);
        }
        if (!dependents.has(node)) {
            dependents.set(node, []);
        }
    }

    for (const [node, inputs] of inputsMap) {
        for (const inputNode of inputs) {
            if (!inDegree.has(inputNode)) {
                continue;
            }
            inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
            const depList = dependents.get(inputNode) ?? [];
            depList.push(node);
            dependents.set(inputNode, depList);
        }
    }

    // Min-heap for string keys.
    /** @type {NodeKeyString[]} */
    const heap = [];
    for (const [node, degree] of inDegree) {
        if (degree === 0) {
            heap.push(node);
        }
    }
    heap.sort((a, b) => -compareNodeKeyStrings(nodeKeyStringToString(a), nodeKeyStringToString(b))); // max-heap for pop

    /** @type {NodeKeyString[]} */
    const sorted = [];
    /** @type {Map<NodeKeyString, number>} */
    const remaining = new Map(inDegree);

    while (heap.length > 0) {
        const node = heap.pop();
        if (node === undefined) continue;

        sorted.push(node);

        const deps = dependents.get(node) ?? [];
        for (const dep of deps) {
            const newDeg = (remaining.get(dep) ?? 0) - 1;
            remaining.set(dep, newDeg);
            if (newDeg === 0) {
                heap.push(dep);
                heap.sort((a, b) => -compareNodeKeyStrings(nodeKeyStringToString(a), nodeKeyStringToString(b)));
            }
        }
    }

    if (sorted.length !== allNodes.length) {
        const sortedSet = new Set(sorted);
        const cycleNodes = allNodes.filter(n => !sortedSet.has(n));
        throw new TopologicalSortCycleError(cycleNodes.map(k => stringToNodeIdentifier(nodeKeyStringToString(k))));
    }

    return sorted;
}

module.exports = {
    buildMergePlan,
};
