/**
 * DependencyGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseEntry} DatabaseEntry */
/** @typedef {import('./types').Computor} Computor */
/** @typedef {import('./types').GraphNode} GraphNode */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

const { isUnchanged } = require('./unchanged');

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
     * @returns {Promise<boolean>} True if any propagation occurred, false if no dirty flags found
     */
    async step() {
        let propagationOccurred = false;

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

            // Mark all inputs as clean since we're processing them
            for (const inputKey of node.inputs) {
                const entry = await this.database.get(inputKey);
                if (entry && entry.isDirty) {
                    await this.database.put(inputKey, {
                        value: entry.value,
                        isDirty: false,
                    });
                }
            }

            // Get the current output value
            const oldValue = await this.database.get(node.output);

            // Compute the new value
            const computedValue = node.computor(inputs, oldValue);

            // Check if the value changed
            if (isUnchanged(computedValue)) {
                // Mark output as clean even though computation returned unchanged
                if (oldValue) {
                    await this.database.put(node.output, {
                        value: oldValue.value,
                        isDirty: false,
                    });
                }
                continue;
            }

            // Store the computed value with dirty flag set to true
            await this.database.put(node.output, {
                value: computedValue,
                isDirty: true,
            });

            propagationOccurred = true;
        }

        return propagationOccurred;
    }

    /**
     * Repeatedly performs step() until a fixpoint is reached.
     * A fixpoint is reached when no more propagation occurs.
     * @returns {Promise<void>}
     */
    async stepToFixpoint() {
        let propagated = await this.step();
        while (propagated) {
            propagated = await this.step();
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
