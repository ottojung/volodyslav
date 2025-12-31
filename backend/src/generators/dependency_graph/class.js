/**
 * DependencyGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').Computor} Computor */
/** @typedef {import('./types').GraphNode} GraphNode */
/** @typedef {import('./types').Schema} Schema */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */

const { isUnchanged } = require("./unchanged");
const { freshnessKey } = require("../database");
const { makeInvalidNodeError } = require("./errors");
const { canonicalize } = require("./expression");
const { makeSchemaIndex, instantiate } = require("./schema");
const { validateSchemas } = require("./validation");

/**
 * A dependency graph that propagates data through edges based on freshness tracking.
 *
 * Algorithm overview:
 * - pull() checks freshness: up-to-date → return cached, potentially-outdated → maybeRecalculate
 * - maybeRecalculate() pulls all inputs, computes, marks up-to-date
 * - When Unchanged is returned, propagate up-to-date state downstream to potentially-outdated nodes
 * - Supports parameterized schemas that are instantiated on-demand
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

     * Schema index for efficient pattern matching.
     * @private
     * @type {ReturnType<typeof makeSchemaIndex> | null}
     */
    schemaIndex;

    /**
     * Cache of concrete node definitions created from schemas.
     * @private
     * @type {Map<string, GraphNode>}
     */
    concreteNodeCache;

    /**
     * Set of schema pattern outputs (canonical form) that should not be pulled/set directly.
     * @private
     * @type {Set<string>}
     */
    schemaPatterns;

    /**
     * Whether the instance has been initialized (loaded instantiations from DB).
     * @private
     * @type {boolean}
     */
    initialized;

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
        // Ensure initialized
        await this.ensureInitialized();

        // Canonicalize the key
        const canonicalKey = canonicalize(key);

        // Reject schema patterns
        if (this.schemaPatterns.has(canonicalKey)) {
            const error = makeInvalidNodeError(key);
            error.message = "Cannot set a schema pattern directly. Use a concrete instantiation.";
            throw error;
        }

        // Ensure the node exists (creates it if it's a schema instantiation)
        await this.getOrCreateConcreteNode(canonicalKey);

        const batchOperations = [];

        // Store the value
        batchOperations.push(this.putOp(canonicalKey, value));

        // Mark this key as up-to-date
        batchOperations.push(
            this.putOp(freshnessKey(canonicalKey), "up-to-date")
        );

        // Collect operations to mark all dependents as potentially-outdated
        await this.collectMarkDependentsOperations(
            canonicalKey,
            batchOperations
        );

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
     * Register a dependent edge dynamically.
     * @private
     * @param {string} inputKey - The input node name
     * @param {GraphNode} dependentNode - The node that depends on inputKey
     * @returns {void}
     */
    registerDependentEdge(inputKey, dependentNode) {
        if (!this.dependentsMap.has(inputKey)) {
            this.dependentsMap.set(inputKey, []);
        }
        const dependents = this.dependentsMap.get(inputKey);
        if (dependents === undefined) {
            throw new Error(
                `Unexpected undefined value in dependentsMap for key ${inputKey}`
            );
        }

        // Avoid duplicates
        if (!dependents.some((node) => node.output === dependentNode.output)) {
            dependents.push(dependentNode);
        }
    }

    /**
     * Get or create a concrete node definition from a canonical node name.
     * @private
     * @param {string} canonicalKey - Canonical node name
     * @returns {Promise<GraphNode>}
     * @throws {Error} If no schema matches and node not in static graph
     */
    async getOrCreateConcreteNode(canonicalKey) {
        // Check cache first
        if (this.concreteNodeCache.has(canonicalKey)) {
            const cached = this.concreteNodeCache.get(canonicalKey);
            if (cached === undefined) {
                throw new Error(
                    `Unexpected undefined in concreteNodeCache for ${canonicalKey}`
                );
            }
            return cached;
        }

        // Try to find in static graph
        const staticNode = this.graph.find(
            (n) => canonicalize(n.output) === canonicalKey
        );
        if (staticNode) {
            // Cache it
            this.concreteNodeCache.set(canonicalKey, staticNode);
            return staticNode;
        }

        // Try to match against schemas
        if (!this.schemaIndex) {
            throw makeInvalidNodeError(canonicalKey);
        }

        const match = this.schemaIndex.findMatch(canonicalKey);
        if (!match) {
            throw makeInvalidNodeError(canonicalKey);
        }

        const { compiled, bindings } = match;
        const schema = compiled.schema;

        // Instantiate all input expressions
        const variableSet = new Set(schema.variables);
        const concreteInputs = schema.inputs.map((inputExpr) =>
            instantiate(inputExpr, bindings, variableSet)
        );

        // Create concrete node definition
        const concreteNode = {
            output: canonicalKey,
            inputs: concreteInputs,
            /**
             * @param {Array<DatabaseValue>} inputValues
             * @param {DatabaseValue | undefined} oldValue
             * @returns {DatabaseValue | Unchanged}
             */
            computor: (inputValues, oldValue) =>
                schema.computor(inputValues, oldValue, bindings),
        };

        // Cache it
        this.concreteNodeCache.set(canonicalKey, concreteNode);

        // Register dynamic edges
        for (const inputKey of concreteInputs) {
            this.registerDependentEdge(inputKey, concreteNode);
        }

        // Persist instantiation marker (only for parameterized nodes)
        if (schema.variables.length > 0) {
            const instantiationKey = `instantiation:${canonicalKey}`;
            await this.database.put(instantiationKey, /** @type {*} */ (1));
        }

        return concreteNode;
    }

    /**
     * Ensure the graph is initialized by loading previously demanded instantiations.
     * @private
     * @returns {Promise<void>}
     */
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }

        this.initialized = true;

        // Load all instantiation markers from database
        const instantiationKeys = await this.database.keys("instantiation:");

        // Rebuild concrete nodes and edges for each
        for (const key of instantiationKeys) {
            // Extract the concrete node name
            const concreteKey = key.slice("instantiation:".length);

            // Recreate the node (this will rebuild cache and edges)
            try {
                await this.getOrCreateConcreteNode(concreteKey);
            } catch (err) {
                // If we can't recreate it (schema removed?), skip it
                // In production, might want to log this
            }
        }
    }

    /**
     * @constructor
     * @param {Database} database - The database instance
     * @param {Array<GraphNode>} graph - Graph definition with nodes
     * @param {Array<Schema>} schemas - Schema definitions for parameterized nodes
     */
    constructor(database, graph, schemas = []) {
        this.database = database;
        this.graph = graph;
        this.concreteNodeCache = new Map();
        this.schemaPatterns = new Set();
        this.initialized = false;

        // Validate schemas
        if (schemas.length > 0) {
            validateSchemas(schemas);
            this.schemaIndex = makeSchemaIndex(schemas);

            // Build set of schema patterns
            for (const schema of schemas) {
                if (schema.variables.length > 0) {
                    const canonical = canonicalize(schema.output);
                    this.schemaPatterns.add(canonical);
                }
            }
        } else {
            this.schemaIndex = null;
        }

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
        // Ensure initialized
        await this.ensureInitialized();

        // Canonicalize the key
        const canonicalKey = canonicalize(nodeName);

        // Reject schema patterns
        if (this.schemaPatterns.has(canonicalKey)) {
            const error = makeInvalidNodeError(nodeName);
            error.message = "Cannot pull a schema pattern directly. Use a concrete instantiation.";
            throw error;
        }

        // Get or create the node definition
        const nodeDefinition = await this.getOrCreateConcreteNode(canonicalKey);

        // Check freshness of this node
        const nodeFreshness = await this.database.getFreshness(
            freshnessKey(canonicalKey)
        );

        // Fast path: if up-to-date, return cached value immediately
        // By Invariant I2 (Up-to-date Upstream Invariant), if a node is up-to-date,
        // all its inputs are guaranteed to be up-to-date, so no need to check them
        if (nodeFreshness === "up-to-date") {
            const result = await this.database.getValue(canonicalKey);
            if (result === undefined) {
                throw new Error(
                    `Expected value for up-to-date node ${canonicalKey}, but found none.`
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
 * @param {Array<Schema>} schemas - Optional array of parameterized schemas
 * @returns {DependencyGraphClass}
 */
function makeDependencyGraph(database, graph, schemas = []) {
    return new DependencyGraphClass(database, graph, schemas);
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
