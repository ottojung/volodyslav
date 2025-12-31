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
/** @typedef {import('./schema').CompiledSchema} CompiledSchema */
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */

const { isUnchanged } = require("./unchanged");
const { freshnessKey } = require("../database");
const {
    makeInvalidNodeError,
    makeInvalidSchemaError,
    makeSchemaPatternNotAllowedError,
} = require("./errors");
const { canonicalize } = require("./expr");
const {
    validateSchemaVariables,
    compileSchema,
    validateNoSchemaOverlap,
} = require("./schema");
const { unify, substitute } = require("./unify");

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
     * Schema definitions for parameterized nodes.
     * @private
     * @type {Array<Schema>}
     */
    schemas;

    /**
     * Pre-computed map from node name to array of dependent nodes.
     * Maps each node to the list of nodes that directly depend on it.
     * @private
     * @type {Map<string, Array<GraphNode>>}
     */
    dependentsMap;

    /**
     * Index of compiled schemas by (head, arity) for fast lookup.
     * @private
     * @type {Map<string, Array<CompiledSchema>>}
     */
    schemaIndex;

    /**
     * Set of schema patterns (with variables) that cannot be operated on directly.
     * @private
     * @type {Set<string>}
     */
    schemaPatterns;

    /**
     * Cache of concrete instantiated nodes created from schemas.
     * @private
     * @type {Map<string, GraphNode>}
     */
    concreteNodeCache;

    /**
     * Flag to track if initialization (loading demanded instantiations) has been done.
     * @private
     * @type {boolean}
     */
    initialized;

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
        await this.ensureInitialized();

        // Canonicalize the key
        const canonicalKey = canonicalize(key);

        // Reject schema patterns
        if (this.schemaPatterns.has(canonicalKey)) {
            throw makeSchemaPatternNotAllowedError(canonicalKey);
        }

        // Ensure node exists (will create from schema if needed, allow pass-through for constants)
        await this.getOrCreateConcreteNode(canonicalKey, true);

        const batchOperations = [];

        // Store the value
        batchOperations.push(this.putOp(canonicalKey, value));

        // Mark this key as up-to-date
        batchOperations.push(
            this.putOp(freshnessKey(canonicalKey), "up-to-date")
        );

        // Collect operations to mark all dependents as potentially-outdated
        await this.collectMarkDependentsOperations(canonicalKey, batchOperations);

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
     * Registers a dependent edge dynamically.
     * Used when creating concrete instantiations from schemas.
     * @private
     * @param {string} inputKey - The input node key
     * @param {GraphNode} dependent - The dependent node
     * @returns {void}
     */
    registerDependentEdge(inputKey, dependent) {
        if (!this.dependentsMap.has(inputKey)) {
            this.dependentsMap.set(inputKey, []);
        }
        const dependents = this.dependentsMap.get(inputKey);
        if (dependents === undefined) {
            throw new Error(
                `Unexpected undefined value in dependentsMap for key ${inputKey}`
            );
        }

        // Check if already registered (deduplicate)
        const alreadyRegistered = dependents.some(
            (d) => d.output === dependent.output
        );
        if (!alreadyRegistered) {
            dependents.push(dependent);
        }
    }

    /**
     * Finds a schema that matches the given concrete node key.
     * @private
     * @param {string} concreteKeyCanonical - Canonical concrete node key
     * @returns {{ compiledSchema: CompiledSchema, bindings: Record<string, string> } | null}
     */
    findMatchingSchema(concreteKeyCanonical) {
        const { parseExpr } = require("./expr");
        const expr = parseExpr(concreteKeyCanonical);

        const head = expr.name;
        const arity = expr.args.length;
        const indexKey = `${head}/${arity}`;

        const candidates = this.schemaIndex.get(indexKey);
        if (!candidates) {
            return null;
        }

        // Try to unify with each candidate
        for (const compiled of candidates) {
            const result = unify(concreteKeyCanonical, compiled);
            if (result) {
                return {
                    compiledSchema: compiled,
                    bindings: result.bindings,
                };
            }
        }

        return null;
    }

    /**
     * Gets or creates a concrete node instantiation from a schema.
     * @private
     * @param {string} concreteKeyCanonical - Canonical concrete node key
     * @param {boolean} allowPassThrough - If true, allows creating pass-through nodes for constants
     * @returns {Promise<GraphNode>}
     * @throws {Error} If no schema matches and node not in static graph
     */
    async getOrCreateConcreteNode(concreteKeyCanonical, allowPassThrough = false) {
        // Check cache first
        const cached = this.concreteNodeCache.get(concreteKeyCanonical);
        if (cached) {
            return cached;
        }

        // Try to find matching schema
        const match = this.findMatchingSchema(concreteKeyCanonical);
        if (!match) {
            // For constant nodes, create pass-through if allowed
            const { parseExpr } = require("./expr");
            const expr = parseExpr(concreteKeyCanonical);
            
            if (expr.kind === "const" && allowPassThrough) {
                // Create a pass-through node with no inputs
                // This allows nodes to be set/referenced without explicit declaration
                const passThrough = {
                    output: concreteKeyCanonical,
                    inputs: [],
                    computor: (inputs, oldValue) => {
                        if (oldValue === undefined) {
                            throw new Error(
                                `Pass-through node ${concreteKeyCanonical} has no value`
                            );
                        }
                        return oldValue;
                    },
                };
                
                this.concreteNodeCache.set(concreteKeyCanonical, passThrough);
                return passThrough;
            }
            
            // Node doesn't exist - throw error
            throw makeInvalidNodeError(concreteKeyCanonical);
        }

        const { compiledSchema, bindings } = match;
        const schema = compiledSchema.schema;
        const variables = new Set(schema.variables);

        // Instantiate inputs by substituting bindings
        const concreteInputs = schema.inputs.map((inputPattern) =>
            substitute(inputPattern, bindings, variables)
        );

        // Create concrete node with wrapper computor
        const concreteNode = {
            output: concreteKeyCanonical,
            inputs: concreteInputs,
            computor: (inputValues, oldValue) =>
                schema.computor(inputValues, oldValue, bindings),
        };

        // Cache it
        this.concreteNodeCache.set(concreteKeyCanonical, concreteNode);

        // Register dynamic edges
        for (const inputKey of concreteInputs) {
            this.registerDependentEdge(inputKey, concreteNode);
        }

        // Persist instantiation marker (only for parameterized schemas)
        if (schema.variables.length > 0) {
            const instantiationKey = `instantiation:${concreteKeyCanonical}`;
            // Fire and forget - we don't want to block on this
            this.database.put(instantiationKey, 1).catch((err) => {
                // Log error but don't fail
                console.error(
                    `Failed to persist instantiation marker for ${concreteKeyCanonical}:`,
                    err
                );
            });
        }

        return concreteNode;
    }

    /**
     * Ensures initialization has been done (loads demanded instantiations from DB).
     * @private
     * @returns {Promise<void>}
     */
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }

        // Load all instantiation markers from database
        const instantiationKeys = await this.database.keys("instantiation:");

        // Recreate each concrete node
        for (const instantiationKey of instantiationKeys) {
            const concreteKey = instantiationKey.substring(
                "instantiation:".length
            );
            try {
                // This will recreate the node and register its edges
                await this.getOrCreateConcreteNode(concreteKey);
            } catch (err) {
                // If schema no longer exists or node is invalid, skip it
                console.warn(
                    `Failed to recreate instantiation for ${concreteKey}:`,
                    err
                );
            }
        }

        this.initialized = true;
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
        this.schemas = schemas;
        this.initialized = false;

        // Validate all schemas
        for (const schema of schemas) {
            validateSchemaVariables(schema);
        }

        // Compile schemas and validate no overlap
        const compiledSchemas = schemas.map(compileSchema);
        validateNoSchemaOverlap(compiledSchemas);

        // Build schema index by (head, arity)
        this.schemaIndex = new Map();
        this.schemaPatterns = new Set();

        for (const compiled of compiledSchemas) {
            const key = `${compiled.head}/${compiled.arity}`;
            if (!this.schemaIndex.has(key)) {
                this.schemaIndex.set(key, []);
            }
            const indexEntry = this.schemaIndex.get(key);
            if (indexEntry === undefined) {
                throw new Error(`Unexpected undefined in schemaIndex for ${key}`);
            }
            indexEntry.push(compiled);

            // Track schema patterns with variables
            if (compiled.schema.variables.length > 0) {
                this.schemaPatterns.add(canonicalize(compiled.schema.output));
            }
        }

        // Initialize concrete node cache
        this.concreteNodeCache = new Map();

        // Convert static GraphNodes to cache entries (treating them as constant schemas)
        for (const node of graph) {
            const canonical = canonicalize(node.output);
            this.concreteNodeCache.set(canonical, node);
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
        // For inputs, we need to allow pass-through so schemas can reference data nodes
        const inputValues = [];
        for (const inputKey of nodeDefinition.inputs) {
            // Ensure input node exists (allow pass-through for constants)
            await this.getOrCreateConcreteNode(inputKey, true);
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
        await this.ensureInitialized();

        // Canonicalize the node name
        const canonicalName = canonicalize(nodeName);

        // Reject schema patterns
        if (this.schemaPatterns.has(canonicalName)) {
            throw makeSchemaPatternNotAllowedError(canonicalName);
        }

        // Find or create the graph node definition
        const nodeDefinition = await this.getOrCreateConcreteNode(canonicalName);

        // Check freshness of this node
        const nodeFreshness = await this.database.getFreshness(
            freshnessKey(canonicalName)
        );

        // Fast path: if up-to-date, return cached value immediately
        // By Invariant I2 (Up-to-date Upstream Invariant), if a node is up-to-date,
        // all its inputs are guaranteed to be up-to-date, so no need to check them
        if (nodeFreshness === "up-to-date") {
            const result = await this.database.getValue(canonicalName);
            if (result === undefined) {
                throw new Error(
                    `Expected value for up-to-date node ${canonicalName}, but found none.`
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
 * @param {Array<Schema>} schemas - Schema definitions for parameterized nodes (optional)
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
