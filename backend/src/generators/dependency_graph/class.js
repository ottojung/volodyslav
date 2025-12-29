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
        const graphDef = this.graph;

        // Find all nodes that depend on the changed key
        for (const node of graphDef) {
            if (node.inputs.includes(changedKey)) {
                const currentFreshness = await this.database.get(
                    freshnessKey(node.output)
                );

                // Only update if not already dirty (dirty stays dirty)
                if (currentFreshness !== "dirty") {
                    batchOperations.push(
                        this.putOp(
                            freshnessKey(node.output),
                            "potentially-dirty"
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
     * @constructor
     * @param {Database} database - The database instance
     * @param {Array<GraphNode>} graph - Graph definition with nodes
     */
    constructor(database, graph) {
        this.database = database;
        this.graph = graph;
    }

    /**
     * Helper method to propagate clean state to downstream potentially-dirty nodes.
     * This is called when a potentially-dirty node returns Unchanged.
     *
     * @private
     * @param {string} nodeName - The node that was marked clean
     * @param {Array<{type: string, key: string, value: DatabaseStoredValue}>} batchOperations - Batch to add operations to
     * @param {Set<string>} markedClean - Set of nodes that have been queued to mark as clean
     * @returns {Promise<void>}
     */
    async propagateCleanStateDownstream(
        nodeName,
        batchOperations,
        markedClean
    ) {
        // Find all nodes that depend on this node
        const downstreamNodes = this.graph.filter((node) =>
            node.inputs.includes(nodeName)
        );

        for (const downstreamNode of downstreamNodes) {
            const downstreamFreshness = await this.database.getFreshness(
                freshnessKey(downstreamNode.output)
            );

            // Only propagate to potentially-dirty nodes (not dirty ones)
            if (downstreamFreshness !== "potentially-dirty") {
                continue;
            }

            // Check if all inputs of the downstream node are clean (or will be clean after batch)
            let allInputsClean = true;
            for (const inputKey of downstreamNode.inputs) {
                // Check if we've already queued this input to be marked clean
                if (markedClean.has(inputKey)) {
                    continue;
                }

                const inputFreshness = await this.database.getFreshness(
                    freshnessKey(inputKey)
                );
                if (inputFreshness !== "clean") {
                    allInputsClean = false;
                    break;
                }
            }

            // If all inputs are clean, mark this node as clean and recurse
            if (allInputsClean) {
                batchOperations.push(
                    this.putOp(freshnessKey(downstreamNode.output), "clean")
                );
                markedClean.add(downstreamNode.output);
                // Recursively propagate to downstream nodes
                await this.propagateCleanStateDownstream(
                    downstreamNode.output,
                    batchOperations,
                    markedClean
                );
            }
        }
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

        // If not in graph, throw an error
        if (!nodeDefinition) {
            throw makeInvalidNodeError(nodeName);
        }

        // Check if any input needs recomputation
        let needsRecomputation = false;
        for (const inputKey of nodeDefinition.inputs) {
            const inputFreshness = await this.database.getFreshness(
                freshnessKey(inputKey)
            );
            if (inputFreshness !== "clean") {
                needsRecomputation = true;
                break;
            }
        }

        // Check freshness of this node
        const nodeFreshness = await this.database.getFreshness(
            freshnessKey(nodeName)
        );

        // If clean and no inputs need recomputation, return cached value
        if (nodeFreshness === "clean" && !needsRecomputation) {
            return await this.database.getValue(nodeName);
        }

        // Recursively pull all dependencies
        // They will skip recursion if clean
        const inputs = [];
        for (const inputKey of nodeDefinition.inputs) {
            const inputFreshness = await this.database.getFreshness(
                freshnessKey(inputKey)
            );

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

        // Optimization: After pulling dependencies, check if this node has been marked clean
        // by downstream propagation from a potentially-dirty input that returned Unchanged
        // Only skip if the node was NOT already clean before (i.e., it was marked clean during pull)
        const nodeFreshnessAfterPull = await this.database.getFreshness(
            freshnessKey(nodeName)
        );
        if (nodeFreshness !== "clean" && nodeFreshnessAfterPull === "clean") {
            // Node was marked clean by downstream propagation, no need to recompute
            // Just mark inputs as clean if needed
            const batchOperations = [];

            for (const inputKey of nodeDefinition.inputs) {
                const inputFreshness = await this.database.getFreshness(
                    freshnessKey(inputKey)
                );
                if (inputFreshness !== "clean") {
                    batchOperations.push(
                        this.putOp(freshnessKey(inputKey), "clean")
                    );
                }
            }

            await this.database.batch(batchOperations);

            return await this.database.getValue(nodeName);
        }

        // Get the current output value
        const oldValue = await this.database.getValue(nodeName);

        // Compute the new value
        const computedValue = nodeDefinition.computor(inputs, oldValue);

        // Prepare batch operations
        const batchOperations = [];

        // Mark all inputs as clean
        for (const inputKey of nodeDefinition.inputs) {
            const inputFreshness = await this.database.getFreshness(
                freshnessKey(inputKey)
            );
            if (inputFreshness !== "clean") {
                batchOperations.push(
                    this.putOp(freshnessKey(inputKey), "clean")
                );
            }
        }

        // Track which nodes we're marking clean in this batch
        const markedClean = new Set([nodeName]);
        for (const inputKey of nodeDefinition.inputs) {
            const inputFreshness = await this.database.getFreshness(
                freshnessKey(inputKey)
            );
            if (inputFreshness !== "clean") {
                markedClean.add(inputKey);
            }
        }

        // Store the new value and mark as clean
        if (!isUnchanged(computedValue)) {
            batchOperations.push(this.putOp(nodeName, computedValue));
            batchOperations.push(this.putOp(freshnessKey(nodeName), "clean"));
        } else {
            // Value unchanged - mark as clean to avoid recomputation
            batchOperations.push(this.putOp(freshnessKey(nodeName), "clean"));

            // Optimization: If this node was potentially-dirty and returns Unchanged,
            // propagate clean state to downstream potentially-dirty nodes
            if (nodeFreshness === "potentially-dirty") {
                await this.propagateCleanStateDownstream(
                    nodeName,
                    batchOperations,
                    markedClean
                );
            }
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
