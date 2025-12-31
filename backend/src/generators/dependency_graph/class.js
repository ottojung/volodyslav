/**
 * Unified DependencyGraph class using CompiledNode representation.
 * Replaces the old split between GraphNodes and Schemas.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./compiled_node').CompiledNode} CompiledNode */
/** @typedef {import('./expr').ConstValue} ConstValue */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */

const { isUnchanged } = require("./unchanged");
const { freshnessKey } = require("../database");
const {
    makeInvalidNodeError,
    makeSchemaPatternNotAllowedError,
} = require("./errors");
const { canonicalize } = require("./expr");
const { compileNodeDef } = require("./compiled_node");
const { matchConcrete, substitute, nodesOverlap } = require("./unify");

/**
 * A dependency graph that propagates data through edges based on freshness tracking.
 * Uses unified CompiledNode representation for both exact and parameterized nodes.
 */
class DependencyGraphClass {
    /**
     * The underlying database instance.
     * @private
     * @type {Database}
     */
    database;

    /**
     * Container of all compiled nodes (both exact and patterns).
     * @private
     * @type {Map<string, CompiledNode>}
     */
    graph;

    /**
     * Index for fast lookup of exact nodes by canonical output.
     * @private
     * @type {Map<string, CompiledNode>}
     */
    exactIndex;

    /**
     * Index for fast lookup of pattern nodes by (head, arity).
     * @private
     * @type {Map<string, Array<CompiledNode>>}
     */
    patternIndex;

    /**
     * Set of pattern outputs (with variables) that cannot be operated on directly.
     * @private
     * @type {Set<string>}
     */
    patternOutputs;

    /**
     * Pre-computed map from node output to array of dependent nodes.
     * @private
     * @type {Map<string, Array<CompiledNode>>}
     */
    dependentsMap;

    /**
     * Cache of concrete instantiated nodes created from patterns.
     * @private
     * @type {Map<string, CompiledNode>}
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
        const dependentNodes = this.dependentsMap.get(changedKey) || [];

        for (const node of dependentNodes) {
            const currentFreshness = await this.database.getFreshness(
                freshnessKey(node.canonicalOutput)
            );

            if (currentFreshness !== "potentially-outdated") {
                batchOperations.push(
                    this.putOp(
                        freshnessKey(node.canonicalOutput),
                        "potentially-outdated"
                    )
                );

                await this.collectMarkDependentsOperations(
                    node.canonicalOutput,
                    batchOperations
                );
            }
        }
    }

    /**
     * Sets a specific node's value, marking it up-to-date and propagating changes.
     * @param {string} key - The name of the node to set
     * @param {DatabaseValue} value - The value to set
     * @returns {Promise<void>}
     */
    async set(key, value) {
        await this.ensureInitialized();

        const canonicalKey = canonicalize(key);

        // Reject pattern outputs
        if (this.patternOutputs.has(canonicalKey)) {
            throw makeSchemaPatternNotAllowedError(canonicalKey);
        }

        // Ensure node exists (will create from pattern if needed, allow pass-through for constants)
        await this.getOrCreateConcreteNode(canonicalKey, true);

        const batchOperations = [];

        batchOperations.push(this.putOp(canonicalKey, value));
        batchOperations.push(
            this.putOp(freshnessKey(canonicalKey), "up-to-date")
        );

        await this.collectMarkDependentsOperations(canonicalKey, batchOperations);

        await this.database.batch(batchOperations);
    }

    /**
     * Pre-computes the dependents map for efficient lookups.
     * @private
     * @returns {void}
     */
    calculateDependents() {
        for (const [, node] of this.graph) {
            for (const inputKey of node.canonicalInputs) {
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
     * @private
     * @param {string} inputKey - The input node key
     * @param {CompiledNode} dependent - The dependent node
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

        const alreadyRegistered = dependents.some(
            (d) => d.canonicalOutput === dependent.canonicalOutput
        );
        if (!alreadyRegistered) {
            dependents.push(dependent);
        }
    }

    /**
     * Finds a pattern that matches the given concrete node key.
     * @private
     * @param {string} concreteKeyCanonical - Canonical concrete node key
     * @returns {{ compiledNode: CompiledNode, bindings: Record<string, ConstValue> } | null}
     */
    findMatchingPattern(concreteKeyCanonical) {
        const { parseExpr } = require("./expr");
        const expr = parseExpr(concreteKeyCanonical);

        const head = expr.name;
        const arity = expr.args.length;
        const indexKey = `${head}/${arity}`;

        const candidates = this.patternIndex.get(indexKey);
        if (!candidates) {
            return null;
        }

        for (const compiled of candidates) {
            const result = matchConcrete(concreteKeyCanonical, compiled);
            if (result) {
                return {
                    compiledNode: compiled,
                    bindings: result.bindings,
                };
            }
        }

        return null;
    }

    /**
     * Gets or creates a concrete node instantiation from a pattern.
     * @private
     * @param {string} concreteKeyCanonical - Canonical concrete node key
     * @param {boolean} allowPassThrough - If true, allows creating pass-through nodes for constants
     * @returns {Promise<CompiledNode>}
     * @throws {Error} If no pattern matches and node not in graph
     */
    async getOrCreateConcreteNode(concreteKeyCanonical, allowPassThrough = false) {
        // Check cache first
        const cached = this.concreteNodeCache.get(concreteKeyCanonical);
        if (cached) {
            return cached;
        }

        // Check if it's in the exact index
        const exact = this.exactIndex.get(concreteKeyCanonical);
        if (exact) {
            return exact;
        }

        // Try to find matching pattern
        const match = this.findMatchingPattern(concreteKeyCanonical);
        if (!match) {
            // For head-only constants, create pass-through if allowed
            const { parseExpr } = require("./expr");
            const expr = parseExpr(concreteKeyCanonical);
            
            if (expr.kind === "const" && allowPassThrough) {
                // Create a pass-through node with no inputs
                /** @type {NodeDef} */
                const passThrough = {
                    output: concreteKeyCanonical,
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => {
                        if (oldValue === undefined) {
                            throw new Error(
                                `Pass-through node ${concreteKeyCanonical} has no value`
                            );
                        }
                        return oldValue;
                    },
                };
                
                const compiled = compileNodeDef(passThrough);
                this.concreteNodeCache.set(concreteKeyCanonical, compiled);
                return compiled;
            }
            
            throw makeInvalidNodeError(concreteKeyCanonical);
        }

        const { compiledNode, bindings } = match;
        const outputVars = new Set();
        for (let i = 0; i < compiledNode.outputArgKinds.length; i++) {
            if (compiledNode.outputArgKinds[i] === "var") {
                const term = compiledNode.outputExpr.args[i];
                if (term && term.kind === "var") {
                    outputVars.add(term.name);
                }
            }
        }

        // Instantiate inputs by substituting bindings
        const concreteInputs = compiledNode.canonicalInputs.map((inputPattern) =>
            substitute(inputPattern, bindings, outputVars)
        );

        // Create concrete node with wrapper computor
        /** @type {NodeDef} */
        const concreteNodeDef = {
            output: concreteKeyCanonical,
            inputs: concreteInputs,
            computor: (inputValues, oldValue, _bindings) =>
                compiledNode.source.computor(inputValues, oldValue, bindings),
        };

        const concreteNode = compileNodeDef(concreteNodeDef);

        // Cache it
        this.concreteNodeCache.set(concreteKeyCanonical, concreteNode);

        // Register dynamic edges
        for (const inputKey of concreteInputs) {
            this.registerDependentEdge(inputKey, concreteNode);
        }

        // Persist instantiation marker
        const instantiationKey = `instantiation:${concreteKeyCanonical}`;
        this.database.put(instantiationKey, /** @type {DatabaseValue} */ (/** @type {unknown} */ (1))).catch((err) => {
            console.error(
                `Failed to persist instantiation marker for ${concreteKeyCanonical}:`,
                err
            );
        });

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

        const instantiationKeys = await this.database.keys("instantiation:");

        for (const instantiationKey of instantiationKeys) {
            const concreteKey = instantiationKey.substring(
                "instantiation:".length
            );
            try {
                await this.getOrCreateConcreteNode(concreteKey);
            } catch (err) {
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
     * @param {Array<NodeDef>} nodeDefs - Unified node definitions (both exact and patterns)
     */
    constructor(database, nodeDefs) {
        this.database = database;
        this.initialized = false;

        // Compile all node definitions
        const compiledNodes = nodeDefs.map((nodeDef) => compileNodeDef(nodeDef));

        // Validate no overlaps
        for (let i = 0; i < compiledNodes.length; i++) {
            for (let j = i + 1; j < compiledNodes.length; j++) {
                const node1 = compiledNodes[i];
                const node2 = compiledNodes[j];
                if (node1 === undefined || node2 === undefined) {
                    throw new Error("Unexpected undefined compiled node");
                }
                if (nodesOverlap(node1, node2)) {
                    const { makeInvalidSchemaError } = require("./errors");
                    throw makeInvalidSchemaError(
                        `Overlaps with node '${node2.canonicalOutput}'`,
                        node1.canonicalOutput
                    );
                }
            }
        }

        // Build graph container and indexes
        this.graph = new Map();
        this.exactIndex = new Map();
        this.patternIndex = new Map();
        this.patternOutputs = new Set();

        for (const compiled of compiledNodes) {
            this.graph.set(compiled.canonicalOutput, compiled);

            if (compiled.isPattern) {
                // It's a pattern - add to pattern index
                const key = `${compiled.head}/${compiled.arity}`;
                if (!this.patternIndex.has(key)) {
                    this.patternIndex.set(key, []);
                }
                const indexEntry = this.patternIndex.get(key);
                if (indexEntry === undefined) {
                    throw new Error(`Unexpected undefined in patternIndex for ${key}`);
                }
                indexEntry.push(compiled);

                this.patternOutputs.add(compiled.canonicalOutput);
            } else {
                // It's exact - add to exact index
                if (this.exactIndex.has(compiled.canonicalOutput)) {
                    const { makeInvalidSchemaError } = require("./errors");
                    throw makeInvalidSchemaError(
                        "Duplicate exact node output",
                        compiled.canonicalOutput
                    );
                }
                this.exactIndex.set(compiled.canonicalOutput, compiled);
            }
        }

        // Initialize concrete node cache
        this.concreteNodeCache = new Map();

        // Pre-compute reverse dependency map
        this.dependentsMap = new Map();
        this.calculateDependents();
    }

    /**
     * Propagates up-to-date state to downstream potentially-outdated nodes.
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
                freshnessKey(dependent.canonicalOutput)
            );

            if (depFreshness !== "potentially-outdated") {
                continue;
            }

            let allInputsUpToDate = true;
            for (const inputKey of dependent.canonicalInputs) {
                const inputFreshness = await this.database.getFreshness(
                    freshnessKey(inputKey)
                );
                if (inputFreshness !== "up-to-date") {
                    allInputsUpToDate = false;
                    break;
                }
            }

            if (allInputsUpToDate) {
                batchOperations.push(
                    this.putOp(freshnessKey(dependent.canonicalOutput), "up-to-date")
                );
                nodesToPropagate.push(dependent.canonicalOutput);
            }
        }

        if (batchOperations.length > 0) {
            await this.database.batch(batchOperations);

            for (const nodeToPropagate of nodesToPropagate) {
                await this.propagateUpToDateDownstream(nodeToPropagate);
            }
        }
    }

    /**
     * Maybe recalculates a potentially-outdated node.
     * @private
     * @param {CompiledNode} nodeDefinition - The node to maybe recalculate
     * @returns {Promise<DatabaseValue>}
     */
    async maybeRecalculate(nodeDefinition) {
        const nodeName = nodeDefinition.canonicalOutput;

        const initialFreshness = await this.database.getFreshness(
            freshnessKey(nodeName)
        );

        // Pull all inputs
        const inputValues = [];
        for (const inputKey of nodeDefinition.canonicalInputs) {
            await this.getOrCreateConcreteNode(inputKey, true);
            const inputValue = await this.pull(inputKey);
            inputValues.push(inputValue);
        }

        const nodeFreshnessAfterPull = await this.database.getFreshness(
            freshnessKey(nodeName)
        );
        if (
            nodeFreshnessAfterPull === "up-to-date" &&
            initialFreshness !== "up-to-date"
        ) {
            const result = await this.database.getValue(nodeName);
            if (result === undefined) {
                throw new Error(
                    `Expected value for up-to-date node ${nodeName}, but found none.`
                );
            }
            return result;
        }

        const oldValue = await this.database.getValue(nodeName);

        // Call computor with empty bindings (actual bindings were captured during instantiation)
        const computedValue = nodeDefinition.source.computor(inputValues, oldValue, {});

        const batchOperations = [];

        for (const inputKey of nodeDefinition.canonicalInputs) {
            batchOperations.push(
                this.putOp(freshnessKey(inputKey), "up-to-date")
            );
        }

        if (!isUnchanged(computedValue)) {
            batchOperations.push(this.putOp(nodeName, computedValue));
            batchOperations.push(
                this.putOp(freshnessKey(nodeName), "up-to-date")
            );

            await this.database.batch(batchOperations);
        } else {
            batchOperations.push(
                this.putOp(freshnessKey(nodeName), "up-to-date")
            );

            await this.database.batch(batchOperations);

            await this.propagateUpToDateDownstream(nodeName);
        }

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
     * @param {string} nodeName - The name of the node to pull
     * @returns {Promise<DatabaseValue>} The node's value
     */
    async pull(nodeName) {
        await this.ensureInitialized();

        const canonicalName = canonicalize(nodeName);

        // Reject pattern outputs
        if (this.patternOutputs.has(canonicalName)) {
            throw makeSchemaPatternNotAllowedError(canonicalName);
        }

        const nodeDefinition = await this.getOrCreateConcreteNode(canonicalName);

        const nodeFreshness = await this.database.getFreshness(
            freshnessKey(canonicalName)
        );

        if (nodeFreshness === "up-to-date") {
            const result = await this.database.getValue(canonicalName);
            if (result === undefined) {
                throw new Error(
                    `Expected value for up-to-date node ${canonicalName}, but found none.`
                );
            }
            return result;
        }

        return await this.maybeRecalculate(nodeDefinition);
    }
}

/**
 * Factory function to create a DependencyGraph instance.
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