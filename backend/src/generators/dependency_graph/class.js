/**
 * DependencyGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').Computor} Computor */
/** @typedef {import('./types').GraphNode} GraphNode */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */

const { isUnchanged } = require("./unchanged");
const { freshnessKey } = require("../database");
const { makeInvalidNodeError } = require("./errors");

/**
 * A dependency graph that propagates data through edges based on dirty flags.
 *
 * Algorithm overview:
 * - pull() checks freshness: clean → return cached, dirty → recalculate, potentially-dirty → maybeRecalculate
 * - recalculate() pulls all inputs, computes output, marks clean, propagates potentially-dirty
 * - maybeRecalculate() checks if inputs are clean; if so, return cached; otherwise recalculate
 * - When Unchanged is returned, propagate clean state downstream to potentially-dirty nodes
 */
class DependencyGraphClass {
    /**
     * The underlying database instance.
     * @private
     * @type {Database}
     */
    database;

    /**
     * Graph definition with nodes and their dependencies.
     * @private
     * @type {Array<GraphNode>}
     */
    graph;

    /**
     * Pre-computed map from node name to array of dependent nodes.
     * Maps each node to the list of nodes that directly depend on it.
     * @private
     * @type {Map<string, Array<GraphNode>>}
     */
    dependentsMap;

    /**
     * Helper to create a put operation for batch processing.
     * @private
     * @param {string} key
     * @param {DatabaseStoredValue} value
     * @returns {{ type: "put", key: string, value: DatabaseStoredValue }}
     */
    putOp(key, value) {
        return { type: "put", key, value };
    }

    /**
     * Recursively collects operations to mark dependent nodes as potentially-dirty.
     * @private
     * @param {string} changedKey - The key that was changed
     * @param {Array<{type: string, key: string, value: DatabaseStoredValue}>} batchOperations - Batch to add operations to
     * @returns {Promise<void>}
     */
    async collectMarkDependentsOperations(changedKey, batchOperations) {
        // Use pre-computed dependents map for O(1) lookup
        const dependentNodes = this.dependentsMap.get(changedKey) || [];

        for (const node of dependentNodes) {
            const currentFreshness = await this.database.getFreshness(
                freshnessKey(node.output)
            );

            // Only update if not already dirty (dirty stays dirty)
            if (currentFreshness !== "dirty") {
                batchOperations.push(
                    this.putOp(freshnessKey(node.output), "potentially-dirty")
                );

                // Recursively mark dependents of this node
                await this.collectMarkDependentsOperations(
                    node.output,
                    batchOperations
                );
            }
        }
    }

    /**
     * Sets a specific node's value, marking it dirty and propagating changes.
     * All operations are performed atomically in a single batch.
     * @param {string} key - The name of the node to set
     * @param {DatabaseValue} value - The value to set
     * @returns {Promise<void>}
     */
    async set(key, value) {
        const batchOperations = [];

        // Store the value
        batchOperations.push(this.putOp(key, value));

        // Mark this key as dirty
        batchOperations.push(this.putOp(freshnessKey(key), "dirty"));

        // Collect operations to mark all dependents as potentially-dirty
        await this.collectMarkDependentsOperations(key, batchOperations);

        // Execute all operations atomically
        await this.database.batch(batchOperations);
    }

    /**
     * Pre-computes the dependents map for efficient lookups.
     * @private
     * @returns {void}
     */
    calculateDependents() {
        for (const node of this.graph) {
            for (const inputKey of node.inputs) {
                if (!this.dependentsMap.has(inputKey)) {
                    this.dependentsMap.set(inputKey, []);
                }
                const val = this.dependentsMap.get(inputKey);
                if (val === undefined) {
                    throw new Error(
                        `Unexpected undefined value in dependentsMap for key ${inputKey}`
                    );
                }
                val.push(node);
            }
        }
    }

    /**
     * @constructor
     * @param {Database} database - The database instance
     * @param {Array<GraphNode>} graph - Graph definition with nodes
     */
    constructor(database, graph) {
        this.database = database;
        this.graph = graph;

        // Pre-compute reverse dependency map for O(1) lookups
        // Maps each node to the list of nodes that depend on it
        this.dependentsMap = new Map();
        this.calculateDependents();
    }

    /**
     * Propagates clean state to downstream potentially-dirty nodes.
     * Called AFTER a node is marked clean.
     * Only affects potentially-dirty nodes whose inputs are all clean.
     *
     * @private
     * @param {string} nodeName - The node that was marked clean
     * @returns {Promise<void>}
     */
    async propagateCleanDownstream(nodeName) {
        const dependents = this.dependentsMap.get(nodeName) || [];
        const batchOperations = [];
        const nodesToPropagate = [];

        for (const dependent of dependents) {
            const depFreshness = await this.database.getFreshness(
                freshnessKey(dependent.output)
            );

            // Only process potentially-dirty nodes
            if (depFreshness !== "potentially-dirty") {
                continue;
            }

            // Check if all inputs are clean
            let allInputsClean = true;
            for (const inputKey of dependent.inputs) {
                const inputFreshness = await this.database.getFreshness(
                    freshnessKey(inputKey)
                );
                if (inputFreshness !== "clean") {
                    allInputsClean = false;
                    break;
                }
            }

            // If all inputs clean, mark this node clean and remember to recurse
            if (allInputsClean) {
                batchOperations.push(
                    this.putOp(freshnessKey(dependent.output), "clean")
                );
                nodesToPropagate.push(dependent.output);
            }
        }

        // Execute batch if we have operations
        if (batchOperations.length > 0) {
            await this.database.batch(batchOperations);

            // AFTER batch commits, recursively propagate for each newly-marked-clean node
            for (const nodeToPropagate of nodesToPropagate) {
                await this.propagateCleanDownstream(nodeToPropagate);
            }
        }
    }

    /**
     * Recalculates a node by pulling all inputs and computing the output.
     * Marks the node and inputs as clean.
     * Does NOT propagate to dependents - they keep their current freshness state.
     * Exception: if computation returns Unchanged, propagate clean downstream.
     *
     * @private
     * @param {GraphNode} nodeDefinition - The node to recalculate
     * @returns {Promise<DatabaseValue>}
     */
    async recalculate(nodeDefinition) {
        const nodeName = nodeDefinition.output;

        // Pull all inputs (recursively ensures they're clean)
        const inputValues = [];
        for (const inputKey of nodeDefinition.inputs) {
            const inputValue = await this.pull(inputKey);
            inputValues.push(inputValue);
        }

        // Get old value
        const oldValue = await this.database.getValue(nodeName);

        // Compute new value
        const computedValue = nodeDefinition.computor(inputValues, oldValue);

        // Prepare batch operations
        const batchOperations = [];

        // Mark all inputs as clean (should already be clean from pull, but make explicit)
        for (const inputKey of nodeDefinition.inputs) {
            batchOperations.push(this.putOp(freshnessKey(inputKey), "clean"));
        }

        // Store result and mark node clean
        if (!isUnchanged(computedValue)) {
            batchOperations.push(this.putOp(nodeName, computedValue));
            batchOperations.push(this.putOp(freshnessKey(nodeName), "clean"));

            // Execute all operations atomically
            await this.database.batch(batchOperations);
        } else {
            // Value unchanged: mark clean and propagate downstream
            batchOperations.push(this.putOp(freshnessKey(nodeName), "clean"));

            // Execute all operations atomically
            await this.database.batch(batchOperations);

            // AFTER marking clean, propagate clean downstream
            // This is the key optimization for Unchanged!
            await this.propagateCleanDownstream(nodeName);
        }

        // Return the current value
        const result = await this.database.getValue(nodeName);
        if (result === undefined) {
            throw new Error(
                `Expected value for clean node ${nodeName}, but found none.`
            );
        }
        return result;
    }

    /**
     * Maybe recalculates a potentially-dirty node.
     * If all inputs are clean, returns cached value.
     * Otherwise, recalculates like a dirty node.
     * Special optimization: if computation returns Unchanged, propagate clean downstream.
     *
     * @private
     * @param {GraphNode} nodeDefinition - The node to maybe recalculate
     * @returns {Promise<DatabaseValue>}
     */
    async maybeRecalculate(nodeDefinition) {
        const nodeName = nodeDefinition.output;

        // Remember initial freshness
        const initialFreshness = await this.database.getFreshness(
            freshnessKey(nodeName)
        );

        // Pull all inputs (recursively ensures they're clean)
        const inputValues = [];
        for (const inputKey of nodeDefinition.inputs) {
            const inputValue = await this.pull(inputKey);
            inputValues.push(inputValue);
        }

        // IMPORTANT: After pulling all inputs, check if WE were marked clean BY PROPAGATION
        // This can happen when all inputs returned Unchanged and propagated clean to us
        // Only skip if we were NOT clean initially (i.e., freshness changed during input pulling)
        const nodeFreshnessAfterPull = await this.database.getFreshness(
            freshnessKey(nodeName)
        );
        if (
            nodeFreshnessAfterPull === "clean" &&
            initialFreshness !== "clean"
        ) {
            // We were marked clean by propagation during input pulling
            // No need to recompute!
            const result = await this.database.getValue(nodeName);
            if (result === undefined) {
                throw new Error(
                    `Expected value for clean node ${nodeName}, but found none.`
                );
            }
            return result;
        }

        // After pulling, compute with fresh input values

        // Get old value
        const oldValue = await this.database.getValue(nodeName);

        // Compute new value
        const computedValue = nodeDefinition.computor(inputValues, oldValue);

        // Prepare batch operations
        const batchOperations = [];

        // Mark all inputs as clean
        for (const inputKey of nodeDefinition.inputs) {
            batchOperations.push(this.putOp(freshnessKey(inputKey), "clean"));
        }

        if (!isUnchanged(computedValue)) {
            // Value changed: store it, mark clean
            // Note: We do NOT propagate potentially-dirty here
            // Dependents keep their current freshness state
            batchOperations.push(this.putOp(nodeName, computedValue));
            batchOperations.push(this.putOp(freshnessKey(nodeName), "clean"));

            // Execute all operations atomically
            await this.database.batch(batchOperations);
        } else {
            // Value unchanged: mark clean and propagate downstream
            batchOperations.push(this.putOp(freshnessKey(nodeName), "clean"));

            // Execute all operations atomically
            await this.database.batch(batchOperations);

            // AFTER marking clean, propagate clean downstream
            // This is the key optimization for Unchanged!
            await this.propagateCleanDownstream(nodeName);
        }

        // Return the current value
        const result = await this.database.getValue(nodeName);
        if (result === undefined) {
            throw new Error(
                `Expected value for clean node ${nodeName}, but found none.`
            );
        }
        return result;
    }

    /**
     * Pulls a specific node's value, lazily evaluating dependencies as needed.
     *
     * Algorithm:
     * - If node is clean AND all inputs are clean: return cached value (fast path)
     * - If node is dirty: recalculate
     * - If node is potentially-dirty OR has non-clean inputs: maybe recalculate (check inputs first)
     *
     * @param {string} nodeName - The name of the node to pull
     * @returns {Promise<DatabaseValue>} The node's value
     */
    async pull(nodeName) {
        // Find the graph node definition
        const nodeDefinition = this.graph.find((n) => n.output === nodeName);

        // If not in graph, throw an error
        if (!nodeDefinition) {
            throw makeInvalidNodeError(nodeName);
        }

        // Check freshness of this node
        const nodeFreshness = await this.database.getFreshness(
            freshnessKey(nodeName)
        );

        // Check if all inputs are clean (for fast path)
        let allInputsClean = true;
        if (nodeFreshness === "clean") {
            for (const inputKey of nodeDefinition.inputs) {
                const inputFreshness = await this.database.getFreshness(
                    freshnessKey(inputKey)
                );
                if (inputFreshness !== "clean") {
                    allInputsClean = false;
                    break;
                }
            }
        }

        // Fast path: if clean AND all inputs clean, return cached value
        if (nodeFreshness === "clean" && allInputsClean) {
            const result = await this.database.getValue(nodeName);
            if (result === undefined) {
                throw new Error(
                    `Expected value for clean node ${nodeName}, but found none.`
                );
            }
            return result;
        }

        // Dirty or potentially-dirty or inconsistent state: need to recalculate
        if (nodeFreshness === "dirty") {
            return await this.recalculate(nodeDefinition);
        } else {
            // potentially-dirty or undefined freshness or clean-but-inputs-dirty
            return await this.maybeRecalculate(nodeDefinition);
        }
    }
}

/**
 * Factory function to create a DependencyGraph instance.
 * @param {Database} database - The database instance
 * @param {Array<GraphNode>} graph - Graph definition with nodes
 * @returns {DependencyGraphClass}
 */
function makeDependencyGraph(database, graph) {
    return new DependencyGraphClass(database, graph);
}

/**
 * Type guard for DependencyGraph.
 * @param {unknown} object
 * @returns {object is DependencyGraphClass}
 */
function isDependencyGraph(object) {
    return object instanceof DependencyGraphClass;
}

/** @typedef {DependencyGraphClass} DependencyGraph */

module.exports = {
    makeDependencyGraph,
    isDependencyGraph,
};
