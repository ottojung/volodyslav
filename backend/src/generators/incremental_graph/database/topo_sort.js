/**
 * Stable topological sort for incremental-graph node sets.
 *
 * Provides topologicalSort(), which takes a SchemaStorage and returns the
 * nodes in topological order: root nodes (no inputs) first, leaf nodes (no
 * dependents) last.  Tie-breaking within the same depth level is
 * deterministic: nodes are sorted ascending by their NodeKeyString
 * representation so the output is stable across runs.
 *
 * Uses Kahn's algorithm with a min-heap priority queue for O((N + E) log N)
 * complexity and deterministic ordering.  Throws TopologicalSortCycleError
 * if the graph contains a cycle (which is treated as data corruption).
 */

const { compareNodeKeyStringByNodeKey } = require('./node_key');
const { stringToNodeKeyString } = require('./types');

/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */

/**
 * Minimal binary min-heap backed by an array.
 * Comparator must return negative when a < b, 0 when equal, positive when a > b.
 * @template T
 */
class MinHeap {
    /**
     * @param {(a: T, b: T) => number} compare
     */
    constructor(compare) {
        /** @type {T[]} */
        this._data = [];
        this._compare = compare;
    }

    /** @returns {number} */
    get size() {
        return this._data.length;
    }

    /** @param {T} item */
    push(item) {
        this._data.push(item);
        this._siftUp(this._data.length - 1);
    }

    /** @returns {T | undefined} */
    pop() {
        if (this._data.length === 0) return undefined;
        const top = this._data[0];
        const last = this._data.pop();
        if (this._data.length > 0 && last !== undefined) {
            this._data[0] = last;
            this._siftDown(0);
        }
        return top;
    }

    /** @param {number} i */
    _siftUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            const dataI = this._data[i];
            const dataParent = this._data[parent];
            if (dataI !== undefined && dataParent !== undefined && this._compare(dataI, dataParent) < 0) {
                this._data[parent] = dataI;
                this._data[i] = dataParent;
                i = parent;
            } else {
                break;
            }
        }
    }

    /** @param {number} i */
    _siftDown(i) {
        const n = this._data.length;
        for (;;) {
            let smallest = i;
            const left = (i << 1) + 1;
            const right = left + 1;
            const dataSmallest = this._data[smallest];
            const dataLeft = this._data[left];
            if (left < n && dataLeft !== undefined && dataSmallest !== undefined && this._compare(dataLeft, dataSmallest) < 0) {
                smallest = left;
            }
            const dataSmallest2 = this._data[smallest];
            const dataRight = this._data[right];
            if (right < n && dataRight !== undefined && dataSmallest2 !== undefined && this._compare(dataRight, dataSmallest2) < 0) {
                smallest = right;
            }
            if (smallest === i) break;
            const dataAtI = this._data[i];
            const dataAtSmallest = this._data[smallest];
            if (dataAtI === undefined || dataAtSmallest === undefined) {
                throw new Error('MinHeap invariant violation: undefined element in active range');
            }
            this._data[i] = dataAtSmallest;
            this._data[smallest] = dataAtI;
            i = smallest;
        }
    }
}

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
 * Returns the nodes in stable topological order (roots first, leaves last)
 * from an explicit in-memory inputs map.  The map must contain every node
 * that should appear in the output; edges to nodes not present in the map
 * are silently ignored (so dangling references are treated as external roots).
 *
 * This is the core Kahn's-algorithm implementation shared by both
 * `topologicalSort` (reads from SchemaStorage) and `topologicalSortFromMap`
 * (operates directly on an already-built map).
 *
 * @param {Map<NodeKeyString, NodeKeyString[]>} inputsMap
 *   A map from each node to the list of its input nodes.
 * @returns {NodeKeyString[]}
 * @throws {TopologicalSortCycleError} If the graph contains a cycle.
 */
function topologicalSortFromMap(inputsMap) {
    const allNodes = [...inputsMap.keys()];

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

    // Populate inDegree and dependents from the inputs map.
    for (const [node, inputs] of inputsMap) {
        for (const inputNode of inputs) {
            // Only count edges to nodes that are present in this map.
            if (!inDegree.has(inputNode)) {
                continue;
            }
            inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
            const depList = dependents.get(inputNode) ?? [];
            depList.push(node);
            dependents.set(inputNode, depList);
        }
    }

    // Initialize priority queue with all nodes having in-degree 0.
    const heap = new MinHeap(compareNodeKeyStringByNodeKey);
    for (const [node, degree] of inDegree) {
        if (degree === 0) {
            heap.push(node);
        }
    }

    /** @type {NodeKeyString[]} */
    const sorted = [];
    /** @type {Map<NodeKeyString, number>} */
    const remaining = new Map(inDegree);

    while (heap.size > 0) {
        const node = heap.pop();
        if (node === undefined) break;

        sorted.push(node);

        const deps = dependents.get(node) ?? [];
        for (const dep of deps) {
            const newDeg = (remaining.get(dep) ?? 0) - 1;
            remaining.set(dep, newDeg);
            if (newDeg === 0) {
                heap.push(dep);
            }
        }
    }

    if (sorted.length !== allNodes.length) {
        // Some nodes were never reached — they form a cycle.
        const sortedSet = new Set(sorted);
        const cycleNodes = allNodes.filter(n => !sortedSet.has(n));
        throw new TopologicalSortCycleError(cycleNodes);
    }

    return sorted;
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

    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const inputsMap = new Map();
    for (const node of allNodes) {
        const record = await storage.inputs.get(node);
        const inputs = record
            ? record.inputs.map(s => stringToNodeKeyString(s))
            : [];
        inputsMap.set(node, inputs);
    }

    return topologicalSortFromMap(inputsMap);
}

module.exports = {
    topologicalSort,
    topologicalSortFromMap,
    TopologicalSortCycleError,
    isTopologicalSortCycleError,
};
