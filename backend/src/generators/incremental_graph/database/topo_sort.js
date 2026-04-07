/**
 * Stable topological sort for incremental-graph node sets.
 *
 * Provides topologicalSort(), which takes a SchemaStorage and returns the
 * nodes in topological order: root nodes (no inputs) first, leaf nodes (no
 * dependents) last.  Tie-breaking within the same depth level is
 * deterministic: nodes are sorted ascending by their NodeKeyString
 * representation so the output is stable across runs.
 *
 * Uses Kahn's algorithm with a priority queue backed by a sorted array for
 * determinism.  Throws TopologicalSortCycleError if the graph contains a
 * cycle (which is treated as data corruption).
 */

const { compareNodeKeyStringByNodeKey } = require('./node_key');
const { stringToNodeKeyString } = require('./types');

/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */

/**
 * Thrown when the node graph contains a cycle, which violates the DAG
 * invariant required by the incremental-graph model.  A cycle indicates data
 * corruption and the merge should abort for the affected host.
 */
class TopologicalSortCycleError extends Error {
    /**
     * @param {NodeKeyString[]} cycle - A representative subset of nodes involved in the cycle.
     */
    constructor(cycle) {
        super(
            `Topological sort detected a cycle in the graph involving nodes: ${cycle.join(', ')}`
        );
        this.name = 'TopologicalSortCycleError';
        this.cycle = cycle;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TopologicalSortCycleError}
 */
function isTopologicalSortCycleError(object) {
    return object instanceof TopologicalSortCycleError;
}

/**
 * Collect all materialized node keys from a schema storage (iterates inputs
 * sublevel as the canonical materialized-node registry).
 *
 * @param {SchemaStorage} storage
 * @returns {Promise<NodeKeyString[]>}
 */
async function collectAllNodes(storage) {
    /** @type {NodeKeyString[]} */
    const nodes = [];
    for await (const key of storage.inputs.keys()) {
        nodes.push(key);
    }
    return nodes;
}

/**
 * Returns the nodes in stable topological order (roots first, leaves last).
 *
 * The ordering satisfies: if node B depends on node A, then A appears before
 * B in the result.  Within the same topological depth, nodes are sorted
 * ascending by their NodeKeyString representation.
 *
 * @param {SchemaStorage} storage - Schema storage whose inputs/revdeps graph to sort.
 * @returns {Promise<NodeKeyString[]>}
 * @throws {TopologicalSortCycleError} If the graph contains a cycle.
 */
async function topologicalSort(storage) {
    const allNodes = await collectAllNodes(storage);

    if (allNodes.length === 0) {
        return [];
    }

    // Build: inDegree map and adjacency list (node → list of dependents).
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

    // Populate inDegree and dependents from inputs records.
    for (const node of allNodes) {
        const record = await storage.inputs.get(node);
        if (!record) continue;

        for (const inputStr of record.inputs) {
            const inputNode = stringToNodeKeyString(inputStr);
            // Only count edges to nodes that are materialized in this storage.
            if (!inDegree.has(inputNode)) {
                // inputNode exists in inputs list but is not materialized — skip.
                continue;
            }
            inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
            const depList = dependents.get(inputNode) ?? [];
            depList.push(node);
            dependents.set(inputNode, depList);
        }
    }

    // Initialize queue with all nodes having in-degree 0, sorted for determinism.
    /** @type {NodeKeyString[]} */
    let queue = [];
    for (const [node, degree] of inDegree) {
        if (degree === 0) {
            queue.push(node);
        }
    }
    queue.sort(compareNodeKeyStringByNodeKey);

    /** @type {NodeKeyString[]} */
    const sorted = [];
    /** @type {Map<NodeKeyString, number>} */
    const remaining = new Map(inDegree);

    while (queue.length > 0) {
        const node = queue.shift();
        if (node === undefined) break;

        sorted.push(node);

        const deps = dependents.get(node) ?? [];
        /** @type {NodeKeyString[]} */
        const newlyReady = [];

        for (const dep of deps) {
            const newDeg = (remaining.get(dep) ?? 0) - 1;
            remaining.set(dep, newDeg);
            if (newDeg === 0) {
                newlyReady.push(dep);
            }
        }

        // Sort newly-ready nodes for determinism before merging.
        newlyReady.sort(compareNodeKeyStringByNodeKey);
        // Merge with the existing sorted queue (both arrays are already sorted,
        // concat+sort is O(N log N) but avoids unsafe indexed access under
        // noUncheckedIndexedAccess).
        queue = [...queue, ...newlyReady].sort(compareNodeKeyStringByNodeKey);
    }

    if (sorted.length !== allNodes.length) {
        // Some nodes were never reached — they form a cycle.
        const sortedSet = new Set(sorted);
        const cycleNodes = allNodes.filter(n => !sortedSet.has(n));
        throw new TopologicalSortCycleError(cycleNodes);
    }

    return sorted;
}

module.exports = {
    topologicalSort,
    TopologicalSortCycleError,
    isTopologicalSortCycleError,
};
