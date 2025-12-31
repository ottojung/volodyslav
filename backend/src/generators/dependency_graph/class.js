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
 * A dependency graph that propagates data through edges based on freshness tracking.
 *
 * Algorithm overview:
 * - pull() checks freshness: up-to-date → return cached, potentially-outdated → maybeRecalculate
 * - maybeRecalculate() pulls all inputs, computes, marks up-to-date
 * - When Unchanged is returned, propagate up-to-date state downstream to potentially-outdated nodes
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

            // Only update if not already potentially-outdated
            if (currentFreshness !== "potentially-outdated") {
                batchOperations.push(
                    this.putOp(
                        freshnessKey(node.output),
                        "potentially-outdated"
                    )
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
     * Sets a specific node's value, marking it up-to-date and propagating changes.
     * All operations are performed atomically in a single batch.
     * @param {string} key - The name of the node to set
     * @param {DatabaseValue} value - The value to set
     * @returns {Promise<void>}
     */
    async set(key, value) {
        const batchOperations = [];

        // Store the value
        batchOperations.push(this.putOp(key, value));

        // Mark this key as up-to-date
        batchOperations.push(this.putOp(freshnessKey(key), "up-to-date"));

        // Collect operations to mark all dependents as potentially-outdated
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
     * Propagates up-to-date state to downstream potentially-outdated nodes.
     * Called AFTER a node is marked up-to-date.
     * Only affects potentially-outdated nodes whose inputs are all up-to-date.
     *
     * @private
     * @param {string} nodeName - The node that was marked up-to-date
     * @returns {Promise<void>}
     */
    async propagateUpToDateDownstream(nodeName) {
        const dependents = this.dependentsMap.get(nodeName) || [];
        const batchOperations = [];
        const nodesToPropagate = [];

        for (const dependent of dependents) {
            const depFreshness = await this.database.getFreshness(
                freshnessKey(dependent.output)
            );

            // Only process potentially-outdated nodes
            if (depFreshness !== "potentially-outdated") {
                continue;
            }

            // Check if all inputs are up-to-date
            let allInputsUpToDate = true;
            for (const inputKey of dependent.inputs) {
                const inputFreshness = await this.database.getFreshness(
                    freshnessKey(inputKey)
                );
                if (inputFreshness !== "up-to-date") {
                    allInputsUpToDate = false;
                    break;
                }
            }

            // If all inputs up-to-date, mark this node up-to-date and remember to recurse
            if (allInputsUpToDate) {
                batchOperations.push(
                    this.putOp(freshnessKey(dependent.output), "up-to-date")
                );
                nodesToPropagate.push(dependent.output);
            }
        }

        // Execute batch if we have operations
        if (batchOperations.length > 0) {
            await this.database.batch(batchOperations);

            // AFTER batch commits, recursively propagate for each newly-marked-up-to-date node
            for (const nodeToPropagate of nodesToPropagate) {
                await this.propagateUpToDateDownstream(nodeToPropagate);
            }
        }
    }

    /**
     * Maybe recalculates a potentially-outdated node.
     * If all inputs are up-to-date, returns cached value.
     * Otherwise, recalculates.
     * Special optimization: if computation returns Unchanged, propagate up-to-date downstream.
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

        // Pull all inputs (recursively ensures they're up-to-date)
        const inputValues = [];
        for (const inputKey of nodeDefinition.inputs) {
            const inputValue = await this.pull(inputKey);
            inputValues.push(inputValue);
        }

        // IMPORTANT: After pulling all inputs, check if WE were marked up-to-date BY PROPAGATION
        // This can happen when all inputs returned Unchanged and propagated up-to-date to us
        // Only skip if we were NOT up-to-date initially (i.e., freshness changed during input pulling)
        const nodeFreshnessAfterPull = await this.database.getFreshness(
            freshnessKey(nodeName)
        );
        if (
            nodeFreshnessAfterPull === "up-to-date" &&
            initialFreshness !== "up-to-date"
        ) {
            // We were marked up-to-date by propagation during input pulling
            // No need to recompute!
            const result = await this.database.getValue(nodeName);
            if (result === undefined) {
                throw new Error(
                    `Expected value for up-to-date node ${nodeName}, but found none.`
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

        // Mark all inputs as up-to-date
        for (const inputKey of nodeDefinition.inputs) {
            batchOperations.push(
                this.putOp(freshnessKey(inputKey), "up-to-date")
            );
        }

        if (!isUnchanged(computedValue)) {
            // Value changed: store it, mark up-to-date
            // Note: We do NOT propagate potentially-outdated here
            // Dependents keep their current freshness state
            batchOperations.push(this.putOp(nodeName, computedValue));
            batchOperations.push(
                this.putOp(freshnessKey(nodeName), "up-to-date")
            );

            // Execute all operations atomically
            await this.database.batch(batchOperations);
        } else {
            // Value unchanged: mark up-to-date and propagate downstream
            batchOperations.push(
                this.putOp(freshnessKey(nodeName), "up-to-date")
            );

            // Execute all operations atomically
            await this.database.batch(batchOperations);

            // AFTER marking up-to-date, propagate up-to-date downstream
            // This is the key optimization for Unchanged!
            await this.propagateUpToDateDownstream(nodeName);
        }

        // Return the current value
        const result = await this.database.getValue(nodeName);
        if (result === undefined) {
            throw new Error(
                `Expected value for up-to-date node ${nodeName}, but found none.`
            );
        }
        return result;
    }

    /**
     * Pulls a specific node's value, lazily evaluating dependencies as needed.
     *
     * Algorithm:
     * - If node is up-to-date: return cached value (fast path)
     * - If node is potentially-outdated: maybe recalculate (check inputs first)
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

        // Fast path: if up-to-date, return cached value immediately
        // By Invariant I2 (Up-to-date Upstream Invariant), if a node is up-to-date,
        // all its inputs are guaranteed to be up-to-date, so no need to check them
        if (nodeFreshness === "up-to-date") {
            const result = await this.database.getValue(nodeName);
            if (result === undefined) {
                throw new Error(
                    `Expected value for up-to-date node ${nodeName}, but found none.`
                );
            }
            return result;
        }

        // Potentially-outdated or undefined freshness: need to maybe recalculate
        return await this.maybeRecalculate(nodeDefinition);
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
