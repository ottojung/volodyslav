/**
 * DependencyGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseEntry} DatabaseEntry */
/** @typedef {import('./types').Computor} Computor */
/** @typedef {import('./types').GraphNode} GraphNode */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

const { isUnchanged } = require("./unchanged");

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
        /** @type {Array<{type: 'put', key: string, value: DatabaseEntry}>} */
        const batchOperations = [];

        // Mark all inputs as clean since we're processing them
        for (const node of this.graph) {
            for (const inputKey of node.inputs) {
                const entry = await this.database.get(inputKey);
                if (entry && entry.isDirty) {
                    batchOperations.push({
                        type: "put",
                        key: inputKey,
                        value: {
                            value: entry.value,
                            isDirty: false,
                        },
                    });
                }
            }
        }

        for (const node of this.graph) {
            // Check if any input is dirty
            let hasAnyDirtyInput = false;
            const inputs = [];

            for (const inputKey of node.inputs) {
                const entry = await this.database.get(inputKey);
                if (entry) {
                    inputs.push(entry);
                    if (entry.isDirty) {
                        hasAnyDirtyInput = true;
                    }
                }
            }

            if (!hasAnyDirtyInput) {
                continue;
            }

            // Get the current output value
            const oldValue = await this.database.get(node.output);

            // Compute the new value
            const computedValue = node.computor(inputs, oldValue);

            // Skip if unchanged
            if (isUnchanged(computedValue)) {
                continue;
            }

            // Store the computed value with dirty flag set to true
            await this.database.put(node.output, {
                value: computedValue,
                isDirty: true,
            });

            propagationOccurred = true;
        }

        // Execute all operations in a single atomic batch
        await this.database.batch(batchOperations);

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
     * This method implements pull semantics: it only computes what's necessary
     * to get the requested node's current value.
     *
     * @param {string} nodeName - The name of the node to pull
     * @returns {Promise<DatabaseEntry | undefined>} The node's database entry
     */
    async pull(nodeName) {
        // Find the graph node definition
        const nodeDefinition = this.graph.find((n) => n.output === nodeName);

        // If not in graph, just return the database value
        if (!nodeDefinition) {
            return await this.database.get(nodeName);
        }

        // First, recursively pull all dependencies to ensure they're up to date
        for (const inputKey of nodeDefinition.inputs) {
            await this.pull(inputKey);
        }

        // Now collect all inputs
        const inputs = [];
        let anyDirtyInput = false;
        for (const inputKey of nodeDefinition.inputs) {
            const entry = await this.database.get(inputKey);
            if (entry) {
                inputs.push(entry);
                if (entry.isDirty) {
                    anyDirtyInput = true;
                }
            }
        }

        // Get the current output value
        const oldValue = await this.database.get(nodeName);

        // Check if we need to recompute
        const needsComputation = anyDirtyInput || !oldValue;

        if (!needsComputation) {
            // Already up to date
            return oldValue;
        }

        // Prepare batch operations
        /** @type {Array<{type: 'put', key: string, value: DatabaseEntry}>} */
        const batchOperations = [];

        // Mark all inputs as clean
        for (const inputKey of nodeDefinition.inputs) {
            const entry = await this.database.get(inputKey);
            if (entry && entry.isDirty) {
                batchOperations.push({
                    type: "put",
                    key: inputKey,
                    value: {
                        value: entry.value,
                        isDirty: false,
                    },
                });
            }
        }

        // Compute the new value
        const computedValue = nodeDefinition.computor(inputs, oldValue);

        // Store the new value (always clean after pull)
        if (!isUnchanged(computedValue)) {
            batchOperations.push({
                type: "put",
                key: nodeName,
                value: {
                    value: computedValue,
                    isDirty: false,
                },
            });
        } else if (oldValue) {
            // Keep old value but mark as clean
            batchOperations.push({
                type: "put",
                key: nodeName,
                value: {
                    value: oldValue.value,
                    isDirty: false,
                },
            });
        }

        // Execute all operations atomically
        if (batchOperations.length > 0) {
            await this.database.batch(batchOperations);
        }

        // Return the current (now up-to-date) value
        return await this.database.get(nodeName);
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
