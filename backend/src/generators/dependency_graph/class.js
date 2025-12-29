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

/**
 * A dependency graph that propagates data through edges based on dirty flags.
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
     * @constructor
     * @param {Database} database - The database instance
     * @param {Array<GraphNode>} graph - Graph definition with nodes
     */
    constructor(database, graph) {
        this.database = database;
        this.graph = graph;
    }

    /**
     * Performs one step of dependency propagation.
     * Scans the graph for dirty input nodes and propagates changes to outputs.
     * All database operations are batched together for atomicity.
     * @returns {Promise<boolean>} True if any propagation occurred, false if no dirty flags found
     */
    async step() {
        let propagationOccurred = false;
        const batchOperations = [];

        // Helper to create a put operation
        /**
         * @param {string} key
         * @param {DatabaseStoredValue} value
         * @returns {{ type: "put", key: string, value: DatabaseStoredValue }}
         */
        const putOp = (key, value) => ({ type: "put", key, value });

        for (const node of this.graph) {
            // Check if any input is dirty or potentially-dirty
            let hasAnyDirtyInput = false;
            const inputs = [];

            for (const inputKey of node.inputs) {
                const freshness = await this.database.getFreshness(freshnessKey(inputKey));
                const value = await this.database.getValue(inputKey);
                
                if (value !== undefined) {
                    inputs.push(value);
                    if (freshness === "dirty" || freshness === "potentially-dirty") {
                        hasAnyDirtyInput = true;
                    }
                }
            }

            if (!hasAnyDirtyInput) {
                continue;
            }

            // Mark only dirty inputs as clean (not potentially-dirty)
            // Potentially-dirty inputs should wait until their upstream dependencies propagate
            for (const inputKey of node.inputs) {
                const freshness = await this.database.getFreshness(freshnessKey(inputKey));
                if (freshness === "dirty") {
                    batchOperations.push(putOp(freshnessKey(inputKey), "clean"));
                }
            }

            // Get the current output value
            const oldValue = await this.database.getValue(node.output);

            // Compute the new value
            const computedValue = node.computor(inputs, oldValue);

            // Handle the computed value
            if (!isUnchanged(computedValue)) {
                // Store the computed value with dirty freshness
                batchOperations.push(putOp(node.output, computedValue));
                batchOperations.push(putOp(freshnessKey(node.output), "dirty"));

                propagationOccurred = true;
            } else {
                // Value unchanged - mark output as clean to stop propagation
                batchOperations.push(putOp(freshnessKey(node.output), "clean"));
            }
        }

        // Execute all operations in a single atomic batch
        if (batchOperations.length > 0) {
            await this.database.batch(batchOperations);
        }

        return propagationOccurred;
    }

    /**
     * Repeatedly performs step() until a fixpoint is reached.
     * A fixpoint is reached when no more propagation occurs.
     * Returns true if any propagation occurred during the entire run.
     * @returns {Promise<boolean>}
     */
    async run() {
        const initialPropagation = await this.step();
        let propagated = initialPropagation;
        while (propagated) {
            propagated = await this.step();
        }
        return initialPropagation;
    }

    /**
     * Pulls a specific node's value, lazily evaluating dependencies as needed.
     * Uses freshness tracking: clean nodes skip recursion, dirty/potentially-dirty nodes recurse.
     *
     * @param {string} nodeName - The name of the node to pull
     * @returns {Promise<DatabaseValue | undefined>} The node's value
     */
    async pull(nodeName) {
        // Find the graph node definition
        const nodeDefinition = this.graph.find((n) => n.output === nodeName);

        // If not in graph, just return the database value
        if (!nodeDefinition) {
            return await this.database.getValue(nodeName);
        }

        // Check if any input needs recomputation
        let needsRecomputation = false;
        for (const inputKey of nodeDefinition.inputs) {
            const inputFreshness = await this.database.getFreshness(freshnessKey(inputKey));
            if (inputFreshness !== "clean") {
                needsRecomputation = true;
                break;
            }
        }

        // Check freshness of this node
        const nodeFreshness = await this.database.getFreshness(freshnessKey(nodeName));

        // If clean and no inputs need recomputation, return cached value
        if (nodeFreshness === "clean" && !needsRecomputation) {
            return await this.database.getValue(nodeName);
        }

        // Recursively pull all dependencies
        // They will skip recursion if clean
        const inputs = [];
        for (const inputKey of nodeDefinition.inputs) {
            const inputFreshness = await this.database.getFreshness(freshnessKey(inputKey));
            
            // Recurse if dirty or potentially-dirty (or if freshness not set)
            if (inputFreshness !== "clean") {
                await this.pull(inputKey);
            }
            
            // Get the (now clean) input value
            const inputValue = await this.database.getValue(inputKey);
            if (inputValue !== undefined) {
                inputs.push(inputValue);
            }
        }

        // Get the current output value
        const oldValue = await this.database.getValue(nodeName);

        // Compute the new value
        const computedValue = nodeDefinition.computor(inputs, oldValue);

        // Prepare batch operations
        const batchOperations = [];
        // Helper to create a put operation
        /**
         * @param {string} key
         * @param {DatabaseStoredValue} value
         * @returns {{ type: "put", key: string, value: DatabaseStoredValue }}
         */
        const putOp = (key, value) => ({ type: "put", key, value });

        // Mark all inputs as clean
        for (const inputKey of nodeDefinition.inputs) {
            const inputFreshness = await this.database.getFreshness(freshnessKey(inputKey));
            if (inputFreshness !== "clean") {
                batchOperations.push(putOp(freshnessKey(inputKey), "clean"));
            }
        }

        // Store the new value and mark as clean
        if (!isUnchanged(computedValue)) {
            batchOperations.push(putOp(nodeName, computedValue));
            batchOperations.push(putOp(freshnessKey(nodeName), "clean"));
        } else {
            // Value unchanged - mark as clean to avoid recomputation
            batchOperations.push(putOp(freshnessKey(nodeName), "clean"));
        }

        await this.database.batch(batchOperations);

        // Return the current (now up-to-date) value
        return await this.database.getValue(nodeName);
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
