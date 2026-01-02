/**
 * DependencyGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').FreshnessStatus} FreshnessStatus */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').ConcreteNodeDefinition} ConcreteNodeDefinition */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {import('./graph_storage').GraphStorage} GraphStorage */
/** @typedef {import('../database/types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */

const crypto = require("crypto");
const { isUnchanged } = require("./unchanged");
const {
    makeInvalidNodeError,
    makeMissingValueError,
    makeInvalidSetError,
    makeSchemaOverlapError,
} = require("./errors");
const { canonicalize, parseExpr } = require("./expr");
const {
    compileNodeDef,
    validateNoOverlap,
    validateAcyclic,
} = require("./compiled_node");
const { matchConcrete, substitute, validateConcreteKey } = require("./unify");
const { extractVariables } = require("./compiled_node");
const { makeGraphStorage } = require("./graph_storage");

/**
 * A dependency graph that propagates data through edges based on freshness tracking.
 *
 * Algorithm overview:
 * - pull() checks freshness: up-to-date → return cached, potentially-outdated → maybeRecalculate
 * - maybeRecalculate() pulls all inputs, computes, marks up-to-date
 * - When Unchanged is returned, propagate up-to-date state downstream to potentially-outdated nodes
 *
 * Persistence model:
 * - Reverse dependencies and inputs are persisted in DB under schema-namespaced keys
 * - Schema hash ensures old graph schemas don't interfere with new ones
 * - No initialization scan needed; edges are queryable on demand from DB
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
     * Pre-computed map from node name to array of dependent nodes (for static edges only).
     * Maps each node to the list of nodes that directly depend on it.
     * Dynamic edges from pattern instantiations are stored in DB, not here.
     * @private
     * @type {Map<string, Array<{output: string, inputs: string[]}>>}
     */
    dependentsMap;

    /**
     * Cache of concrete instantiated nodes created from patterns on demand.
     * Maps canonical output to a runtime node with concrete inputs and wrapped computor.
     * @private
     * @type {Map<string, ConcreteNodeDefinition>}
     */
    concreteInstantiations;

    /**
     * Stable hash of the schema (compiled nodes).
     * Used to namespace DB keys so different schemas don't interfere.
     * @private
     * @type {string}
     */
    schemaHash;

    /**
     * Graph storage helper for managing persistent state.
     * @private
     * @type {GraphStorage}
     */
    storage;

    /**
     * Recursively collects operations to mark dependent nodes as potentially-dirty.
     * Uses both static dependents map and DB-persisted reverse dependencies.
     * @private
     * @param {string} changedKey - The key that was changed
     * @param {Array<DatabaseBatchOperation>} batchOperations - Batch to add operations to
     * @param {Set<string>} nodesBecomingOutdated - Set of nodes that are becoming outdated in this batch
     * @returns {Promise<void>}
     */
    async propagateOutdated(
        changedKey,
        batchOperations,
        nodesBecomingOutdated = new Set()
    ) {
        // Collect dependents from both static map and DB
        const staticDependents = this.dependentsMap.get(changedKey) || [];
        const dynamicDependents = await this.storage.listDependents(changedKey);

        // Combine both sources, mapping dynamic dependents to the same structure
        const allDependents = [
            ...staticDependents,
            ...dynamicDependents.map((output) => ({ output, inputs: [] })),
        ];

        for (const node of allDependents) {
            // Optimization: if already marked outdated in this batch, skip
            if (nodesBecomingOutdated.has(node.output)) {
                continue;
            }

            const currentFreshness = await this.storage.getNodeFreshness(
                node.output
            );

            // Only update if not already potentially-outdated
            if (currentFreshness !== "potentially-outdated") {
                batchOperations.push(
                    this.storage.setNodeFreshnessOp(
                        node.output,
                        "potentially-outdated"
                    )
                );
                nodesBecomingOutdated.add(node.output);

                // Recursively mark dependents of this node
                await this.propagateOutdated(
                    node.output,
                    batchOperations,
                    nodesBecomingOutdated
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
        // Canonicalize the key
        const canonicalKey = canonicalize(key);

        // Validate that key is concrete (no variables)
        validateConcreteKey(canonicalKey);

        // Ensure node exists (will create from pattern if needed)
        const nodeDefinition = await this.getOrCreateConcreteNode(canonicalKey);

        // Validate that this is a source node (no inputs)
        if (nodeDefinition.inputs.length > 0) {
            throw makeInvalidSetError(canonicalKey);
        }

        /** @type {Array<DatabaseBatchOperation>} */
        const batchOperations = [];

        // Store the value
        batchOperations.push(this.storage.setNodeValueOp(canonicalKey, value));

        // Mark this key as up-to-date
        batchOperations.push(
            this.storage.setNodeFreshnessOp(canonicalKey, "up-to-date")
        );

        // Collect operations to mark all dependents as potentially-outdated
        await this.propagateOutdated(
            canonicalKey,
            batchOperations
        );

        // Execute all operations atomically
        await this.database.batch(batchOperations);
    }

    /**
     * Pre-computes the dependents map for efficient lookups of static edges.
     * Dynamic edges from pattern instantiations are stored in DB, not here.
     * @private
     * @returns {void}
     */
    calculateDependents() {
        for (const compiled of this.graph.values()) {
            // Only compute for non-pattern nodes (static edges)
            if (!compiled.isPattern) {
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
            // Multiple patterns match - this should be impossible if validateNoOverlap worked correctly
            // This indicates a bug in overlap detection or that the patterns weren't validated
            throw makeSchemaOverlapError(
                matches.map((m) => m.compiledNode.canonicalOutput)
            );
        }

        const match = matches[0];
        if (!match) {
            return null;
        }
        return match;
    }

    /**
     * Gets or creates a concrete node instantiation.
     * Dynamic edges are persisted to DB when the node is computed/set, not here.
     * @private
     * @param {string} concreteKeyCanonical - Canonical concrete node key
     * @returns {Promise<ConcreteNodeDefinition>}
     * @throws {Error} If no pattern matches and node not in graph
     */
    async getOrCreateConcreteNode(concreteKeyCanonical) {
        // Check if it's an exact node in the graph
        const exactNode = this.graphIndex.exactIndex.get(concreteKeyCanonical);
        if (exactNode) {
            return {
                output: exactNode.canonicalOutput,
                inputs: exactNode.canonicalInputs,
                computor: (inputs, oldValue) =>
                    exactNode.source.computor(inputs, oldValue, {}),
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
            // Node doesn't exist - throw error
            throw makeInvalidNodeError(concreteKeyCanonical);
        }

        const { compiledNode, bindings } = match;
        const variables = extractVariables(compiledNode.outputExpr);

        // Instantiate inputs by substituting bindings
        const concreteInputs = compiledNode.canonicalInputs.map(
            (inputPattern) => substitute(inputPattern, bindings, variables)
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
        };

        // Cache it
        this.concreteInstantiations.set(concreteKeyCanonical, concreteNode);

        // Dynamic edges will be persisted to DB when this node is computed or set

        return concreteNode;
    }

    /**
     * @constructor
     * @param {Database} database - The database instance
     * @param {Array<NodeDef>} nodeDefs - Unified node definitions
     */
    constructor(database, nodeDefs) {
        this.database = database;

        // Compile all node definitions
        const compiledNodes = nodeDefs.map(compileNodeDef);

        // Validate no overlaps
        validateNoOverlap(compiledNodes);

        // Validate acyclic
        validateAcyclic(compiledNodes);

        // Compute schema hash for namespacing DB keys
        // Use a stable canonical representation of the schema
        const schemaRepresentation = compiledNodes
            .map((node) => ({
                output: node.canonicalOutput,
                inputs: node.canonicalInputs,
            }))
            .sort((a, b) => a.output.localeCompare(b.output));

        const schemaJson = JSON.stringify(schemaRepresentation);
        this.schemaHash = crypto
            .createHash("md5")
            .update(schemaJson)
            .digest("hex")
            .substring(0, 16); // Use first 16 chars for brevity

        // Initialize storage helper
        this.storage = makeGraphStorage(database, this.schemaHash);

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
                this.graphIndex.exactIndex.set(
                    compiled.canonicalOutput,
                    compiled
                );
            }
        }

        // Initialize instantiation cache
        this.concreteInstantiations = new Map();

        // Pre-compute reverse dependency map for static edges only
        this.dependentsMap = new Map();
        this.calculateDependents();
    }

    /**
     * Propagates up-to-date state to downstream potentially-outdated nodes.
     * Called AFTER a node is marked up-to-date.
     * Only affects potentially-outdated nodes whose inputs are all up-to-date.
     * Uses both static dependents and DB-persisted reverse dependencies.
     *
     * @private
     * @param {string} nodeName - The node that was marked up-to-date
     * @returns {Promise<void>}
     */

    /**
     * Maybe recalculates a potentially-outdated node.
     * If all inputs are up-to-date, returns cached value.
     * Otherwise, recalculates.
     * Special optimization: if computation returns Unchanged, propagate up-to-date downstream.
     *
     * @private
     * @param {ConcreteNodeDefinition} nodeDefinition - The node to maybe recalculate
     * @returns {Promise<RecomputeResult>}
     */
    async maybeRecalculate(nodeDefinition) {
        const nodeName = nodeDefinition.output;

        // Pull all inputs (recursively ensures they're up-to-date)
        const inputValues = [];
        let allInputsUnchanged = true;

        for (const inputKey of nodeDefinition.inputs) {
            // Ensure input node exists
            await this.getOrCreateConcreteNode(inputKey);
            const { value: inputValue, status: inputStatus } =
                await this.pullWithStatus(inputKey);
            inputValues.push(inputValue);

            // If input is NOT 'unchanged', we can't guarantee we are unchanged.
            // 'cached' inputs might have changed since we last ran.
            // 'changed' inputs definitely changed.
            if (inputStatus !== "unchanged") {
                allInputsUnchanged = false;
            }
        }

        // Get old value
        const oldValue = await this.storage.getNodeValue(nodeName);

        // Optimization: if all inputs are 'unchanged' (meaning they were outdated but recomputed to same value),
        // then we can skip recomputation and mark ourselves up-to-date.
        // However, we must still ensure the node is indexed for correct invalidation.
        if (
            allInputsUnchanged &&
            nodeDefinition.inputs.length > 0 &&
            oldValue !== undefined
        ) {
            // Prepare batch operations for the fast path
            /** @type {Array<{type: "put", key: string, value: DatabaseStoredValue} | {type: "del", key: string}>} */
            const batchOperations = [];

            // Ensure node is indexed (if it has inputs)
            // This is critical for pattern nodes which have no static dependents map entry
            await this.storage.ensureNodeIndexed(
                nodeName,
                nodeDefinition.inputs,
                batchOperations
            );

            // Mark up-to-date
            batchOperations.push(
                this.storage.setNodeFreshnessOp(nodeName, "up-to-date")
            );

            // Execute all operations atomically
            await this.database.batch(batchOperations);

            return { value: oldValue, status: "unchanged" };
        }

        // Compute new value
        const computedValue = await nodeDefinition.computor(
            inputValues,
            oldValue
        );

        // Prepare batch operations
        /** @type {Array<DatabaseBatchOperation>} */
        const batchOperations = [];

        // Ensure node is indexed (if it has inputs)
        if (nodeDefinition.inputs.length > 0) {
            await this.storage.ensureNodeIndexed(
                nodeName,
                nodeDefinition.inputs,
                batchOperations
            );
        }

        // Mark all inputs as up-to-date (redundant but safe)
        for (const inputKey of nodeDefinition.inputs) {
            batchOperations.push(
                this.storage.setNodeFreshnessOp(inputKey, "up-to-date")
            );
        }

        if (!isUnchanged(computedValue)) {
            // Value changed: store it, mark up-to-date
            batchOperations.push(
                this.storage.setNodeValueOp(nodeName, computedValue)
            );
            batchOperations.push(
                this.storage.setNodeFreshnessOp(nodeName, "up-to-date")
            );

            // Execute all operations atomically
            await this.database.batch(batchOperations);

            return { value: computedValue, status: "changed" };
        } else {
            // Value unchanged: mark up-to-date
            batchOperations.push(
                this.storage.setNodeFreshnessOp(nodeName, "up-to-date")
            );

            // Execute all operations atomically
            await this.database.batch(batchOperations);

            // Return old value (must exist if Unchanged returned)
            const result = await this.storage.getNodeValue(nodeName);
            if (result === undefined) {
                throw makeMissingValueError(nodeName);
            }
            return { value: result, status: "unchanged" };
        }
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
        const { value } = await this.pullWithStatus(nodeName);
        return value;
    }

    /**
     * Internal pull that returns status for optimization.
     * @private
     * @param {string} nodeName
     * @returns {Promise<RecomputeResult>}
     */
    async pullWithStatus(nodeName) {
        // Canonicalize the node name
        const canonicalName = canonicalize(nodeName);

        // Validate that key is concrete (no variables)
        validateConcreteKey(canonicalName);

        // Find or create the node definition
        const nodeDefinition = await this.getOrCreateConcreteNode(
            canonicalName
        );

        // Check freshness of this node
        const nodeFreshness = await this.storage.getNodeFreshness(
            canonicalName
        );

        // Fast path: if up-to-date, return cached value immediately
        // But first ensure the node is indexed (for pattern nodes in seeded DBs)
        if (nodeFreshness === "up-to-date") {
            // Ensure node is indexed if it has inputs
            // This is critical for seeded databases where values/freshness exist
            // but reverse-dep metadata is missing
            if (nodeDefinition.inputs.length > 0) {
                /** @type {Array<{type: "put", key: string, value: DatabaseStoredValue} | {type: "del", key: string}>} */
                const batchOperations = [];
                
                await this.storage.ensureNodeIndexed(
                    canonicalName,
                    nodeDefinition.inputs,
                    batchOperations
                );
                
                // Execute indexing operations if any were added
                if (batchOperations.length > 0) {
                    await this.database.batch(batchOperations);
                }
            }
            
            const result = await this.storage.getNodeValue(canonicalName);
            if (result === undefined) {
                throw makeMissingValueError(canonicalName);
            }
            return { value: result, status: "cached" };
        }

        // Potentially-outdated or undefined freshness: need to maybe recalculate
        return await this.maybeRecalculate(nodeDefinition);
    }

    /**
     * Query conceptual freshness state of a node.
     * @param {string} nodeName - The name of the node
     * @returns {Promise<FreshnessStatus>}
     */
    async debugGetFreshness(nodeName) {
        const canonicalName = canonicalize(nodeName);
        const freshness = await this.storage.getNodeFreshness(canonicalName);
        if (freshness === undefined) {
            return "missing";
        }
        return freshness;
    }

    /**
     * List all materialized nodes (canonical names).
     * @returns {Promise<string[]>}
     */
    async debugListMaterializedNodes() {
        return this.storage.listMaterializedNodes();
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
