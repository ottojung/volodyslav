/**
 * DependencyGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */

const { isUnchanged } = require("./unchanged");
const { freshnessKey } = require("../database");
const { makeInvalidNodeError } = require("./errors");
const { canonicalize, parseExpr } = require("./expr");
const { compileNodeDef, validateNoOverlap } = require("./compiled_node");
const { matchConcrete, substitute, validateConcreteKey } = require("./unify");
const { extractVariables } = require("./compiled_node");

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
     * All compiled nodes (both exact and patterns).
     * @private
     * @type {Map<string, import('./types').CompiledNode>}
     */
    graph;

    /**
     * Index for fast lookup of compiled nodes.
     * @private
     * @type {{ exactIndex: Map<string, import('./types').CompiledNode>, patternIndex: Map<string, Array<import('./types').CompiledNode>> }}
     */
    graphIndex;

    /**
     * Pre-computed map from node name to array of dependent nodes.
     * Maps each node to the list of nodes that directly depend on it.
     * @private
     * @type {Map<string, Array<{output: string, inputs: string[]}>>}
     */
    dependentsMap;

    /**
     * Cache of concrete instantiated nodes created from patterns on demand.
     * Maps canonical output to a runtime node with concrete inputs and wrapped computor.
     * @private
     * @type {Map<string, {output: string, inputs: string[], computor: (inputs: DatabaseValue[], oldValue: DatabaseValue | undefined) => DatabaseValue | Unchanged}>}
     */
    concreteInstantiations;

    /**
     * Promise to track initialization progress (loading demanded instantiations).
     * Ensures initialization runs only once even under concurrent calls.
     * @private
     * @type {Promise<void> | null}
     */
    initPromise;

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

        // Validate that key is concrete (no variables)
        validateConcreteKey(canonicalKey);

        // Ensure node exists (will create from pattern if needed, allow pass-through for constants)
        const nodeDefinition = await this.getOrCreateConcreteNode(canonicalKey, true);

        const batchOperations = [];

        // Write instantiation marker if this is a parameterized instantiation (first time)
        if (nodeDefinition.__instantiationMarkerKey) {
            const markerExists = await this.database.get(
                nodeDefinition.__instantiationMarkerKey
            );
            if (markerExists === undefined) {
                // Write marker atomically with value/freshness
                // Store a minimal object (DatabaseValue must be an object)
                batchOperations.push(
                    this.putOp(
                        nodeDefinition.__instantiationMarkerKey,
                        /** @type {DatabaseValue} */ (/** @type {unknown} */ ({ __marker: true }))
                    )
                );
            }
        }

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
        for (const compiled of this.graph.values()) {
            for (const inputKey of compiled.canonicalInputs) {
                if (!this.dependentsMap.has(inputKey)) {
                    this.dependentsMap.set(inputKey, []);
                }
                const val = this.dependentsMap.get(inputKey);
                if (val === undefined) {
                    throw new Error(
                        `Unexpected undefined value in dependentsMap for key ${inputKey}`
                    );
                }
                val.push({
                    output: compiled.canonicalOutput,
                    inputs: compiled.canonicalInputs,
                });
            }
        }
    }

    /**
     * Registers a dependent edge dynamically.
     * Used when creating concrete instantiations from patterns.
     * @private
     * @param {string} inputKey - The input node key
     * @param {{output: string, inputs: string[]}} dependent - The dependent node
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
     * Finds a compiled pattern that matches the given concrete node key.
     * Throws if multiple patterns match (ambiguity).
     * @private
     * @param {string} concreteKeyCanonical - Canonical concrete node key
     * @returns {{ compiledNode: CompiledNode, bindings: Record<string, ConstValue> } | null}
     */
    findMatchingPattern(concreteKeyCanonical) {
        const expr = parseExpr(concreteKeyCanonical);

        const head = expr.name;
        const arity = expr.args.length;
        const indexKey = `${head}/${arity}`;

        const candidates = this.graphIndex.patternIndex.get(indexKey);
        if (!candidates) {
            return null;
        }

        // Collect all matching patterns
        /** @type {Array<{ compiledNode: CompiledNode, bindings: Record<string, ConstValue> }>} */
        const matches = [];
        
        for (const compiled of candidates) {
            const result = matchConcrete(concreteKeyCanonical, compiled);
            if (result) {
                matches.push({
                    compiledNode: compiled,
                    bindings: result.bindings,
                });
            }
        }

        if (matches.length === 0) {
            return null;
        }
        
        if (matches.length > 1) {
            // Multiple patterns match - this is ambiguous
            const { makeInvalidSchemaError } = require("./errors");
            const patternList = matches
                .map((m) => `'${m.compiledNode.canonicalOutput}'`)
                .join(", ");
            throw makeInvalidSchemaError(
                `Ambiguous match: concrete key '${concreteKeyCanonical}' matches multiple patterns: ${patternList}`,
                concreteKeyCanonical
            );
        }

        return matches[0];
    }

    /**
     * Gets or creates a concrete node instantiation.
     * @private
     * @param {string} concreteKeyCanonical - Canonical concrete node key
     * @param {boolean} allowPassThrough - If true, allows creating pass-through nodes for constants
     * @returns {Promise<{output: string, inputs: string[], computor: (inputs: DatabaseValue[], oldValue: DatabaseValue | undefined) => DatabaseValue | Unchanged}>}
     * @throws {Error} If no pattern matches and node not in graph
     */
    async getOrCreateConcreteNode(concreteKeyCanonical, allowPassThrough = false) {
        // Check if it's an exact node in the graph
        const exactNode = this.graphIndex.exactIndex.get(concreteKeyCanonical);
        if (exactNode) {
            return {
                output: exactNode.canonicalOutput,
                inputs: exactNode.canonicalInputs,
                computor: (inputs, oldValue) => exactNode.source.computor(inputs, oldValue, {}),
            };
        }

        // Check instantiation cache
        const cached = this.concreteInstantiations.get(concreteKeyCanonical);
        if (cached) {
            return cached;
        }

        // Try to find matching pattern
        const match = this.findMatchingPattern(concreteKeyCanonical);
        if (!match) {
            // For constant nodes, create pass-through if allowed
            const expr = parseExpr(concreteKeyCanonical);
            
            if (expr.kind === "const" && allowPassThrough) {
                // Create a pass-through node with no inputs
                const passThrough = {
                    output: concreteKeyCanonical,
                    inputs: [],
                    /**
                     * @param {Array<DatabaseValue>} _inputs
                     * @param {DatabaseValue | undefined} oldValue
                     * @returns {DatabaseValue}
                     */
                    computor: (_inputs, oldValue) => {
                        if (oldValue === undefined) {
                            throw new Error(
                                `Pass-through node ${concreteKeyCanonical} has no value`
                            );
                        }
                        return oldValue;
                    },
                };
                
                this.concreteInstantiations.set(concreteKeyCanonical, passThrough);
                return passThrough;
            }
            
            // Node doesn't exist - throw error
            throw makeInvalidNodeError(concreteKeyCanonical);
        }

        const { compiledNode, bindings } = match;
        const variables = extractVariables(compiledNode.outputExpr);

        // Instantiate inputs by substituting bindings
        const concreteInputs = compiledNode.canonicalInputs.map((inputPattern) =>
            substitute(inputPattern, bindings, variables)
        );

        // Create concrete node with wrapper computor
        const concreteNode = {
            output: concreteKeyCanonical,
            inputs: concreteInputs,
            /**
             * @param {Array<DatabaseValue>} inputValues
             * @param {DatabaseValue | undefined} oldValue
             * @returns {DatabaseValue | Unchanged}
             */
            computor: (inputValues, oldValue) =>
                compiledNode.source.computor(inputValues, oldValue, bindings),
            // Store instantiation marker key for later atomic persistence
            __instantiationMarkerKey: compiledNode.isPattern
                ? `instantiation:${concreteKeyCanonical}`
                : undefined,
        };

        // Cache it
        this.concreteInstantiations.set(concreteKeyCanonical, concreteNode);

        // Register dynamic edges
        for (const inputKey of concreteInputs) {
            this.registerDependentEdge(inputKey, concreteNode);
        }

        // Instantiation marker will be written atomically in maybeRecalculate or set

        return concreteNode;
    }

    /**
     * Ensures initialization has been done (loads demanded instantiations from DB).
     * Concurrency-safe: multiple concurrent calls will await the same initialization promise.
     * @private
     * @returns {Promise<void>}
     */
    async ensureInitialized() {
        // If initialization is already in progress, await it
        if (this.initPromise) {
            return this.initPromise;
        }

        // Start initialization
        this.initPromise = (async () => {
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
        })();

        return this.initPromise;
    }

    /**
     * @constructor
     * @param {Database} database - The database instance
     * @param {Array<NodeDef>} nodeDefs - Unified node definitions
     */
    constructor(database, nodeDefs) {
        this.database = database;
        this.initPromise = null;

        // Compile all node definitions
        const compiledNodes = nodeDefs.map(compileNodeDef);

        // Validate no overlaps
        validateNoOverlap(compiledNodes);

        // Store compiled nodes in a map by canonical output
        this.graph = new Map();
        for (const compiled of compiledNodes) {
            this.graph.set(compiled.canonicalOutput, compiled);
        }

        // Build graph index
        this.graphIndex = {
            exactIndex: new Map(),
            patternIndex: new Map(),
        };

        for (const compiled of compiledNodes) {
            if (compiled.isPattern) {
                // Pattern node - index by head/arity
                const key = `${compiled.head}/${compiled.arity}`;
                if (!this.graphIndex.patternIndex.has(key)) {
                    this.graphIndex.patternIndex.set(key, []);
                }
                const patterns = this.graphIndex.patternIndex.get(key);
                if (patterns) {
                    patterns.push(compiled);
                }
            } else {
                // Exact node - index by canonical output
                this.graphIndex.exactIndex.set(compiled.canonicalOutput, compiled);
            }
        }

        // Initialize instantiation cache
        this.concreteInstantiations = new Map();

        // Pre-compute reverse dependency map for O(1) lookups
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
     * @param {{output: string, inputs: string[], computor: (inputs: DatabaseValue[], oldValue: DatabaseValue | undefined) => DatabaseValue | Unchanged, __instantiationMarkerKey?: string}} nodeDefinition - The node to maybe recalculate
     * @returns {Promise<DatabaseValue>}
     */
    async maybeRecalculate(nodeDefinition) {
        const nodeName = nodeDefinition.output;

        // Remember initial freshness
        const initialFreshness = await this.database.getFreshness(
            freshnessKey(nodeName)
        );

        // Pull all inputs (recursively ensures they're up-to-date)
        // For inputs, we need to allow pass-through so patterns can reference data nodes
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

        // Write instantiation marker if this is a parameterized instantiation (first time)
        if (nodeDefinition.__instantiationMarkerKey) {
            const markerExists = await this.database.get(
                nodeDefinition.__instantiationMarkerKey
            );
            if (markerExists === undefined) {
                // Write marker atomically with value/freshness
                // Store a minimal object (DatabaseValue must be an object)
                batchOperations.push(
                    this.putOp(
                        nodeDefinition.__instantiationMarkerKey,
                        /** @type {DatabaseValue} */ (/** @type {unknown} */ ({ __marker: true }))
                    )
                );
            }
        }

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

        // Validate that key is concrete (no variables)
        validateConcreteKey(canonicalName);

        // Find or create the node definition
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
 * 
 * @param {Database} database - The database instance
 * @param {Array<NodeDef>} nodeDefs - Unified node definitions
 * @returns {DependencyGraphClass}
 */
function makeDependencyGraph(database, nodeDefs) {
    return new DependencyGraphClass(database, nodeDefs);
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
