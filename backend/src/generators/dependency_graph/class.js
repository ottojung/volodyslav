/**
 * DependencyGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./types').Database} Database */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Version} Version */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').DependencyVersions} DependencyVersions */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {import('./index_helper').Index} Index */
/** @typedef {DatabaseValue | Version | Freshness | DependencyVersions} DatabaseStoredValue */

const crypto = require("crypto");
const { isUnchanged } = require("./unchanged");
const { versionKey, freshnessKey, depVersionsKey, makeDependencyVersions } = require("../database");
const { 
    makeInvalidNodeError, 
    makeInvalidSchemaError,
    makeMissingValueError,
    makeInvalidSetError,
} = require("./errors");
const { canonicalize, parseExpr } = require("./expr");
const { compileNodeDef, validateNoOverlap } = require("./compiled_node");
const { matchConcrete, substitute, validateConcreteKey } = require("./unify");
const { extractVariables } = require("./compiled_node");
const { makeIndex } = require("./index_helper");

/**
 * A dependency graph that propagates data through edges using versions and freshness.
 *
 * Algorithm overview:
 * - Each node has a value_version that increments only when its value changes
 * - Each node stores dep_versions - snapshot of dependency versions from last computation
 * - Each node has a freshness flag: "up-to-date" or "potentially-outdated"
 * - set() marks node as up-to-date and propagates "potentially-outdated" to all dependents
 * - Local up-to-date check: node is "up-to-date" OR (is "potentially-outdated" but dep versions match snapshot)
 * - pull() checks locally if up-to-date → return cached, else pull dependencies and recompute
 * - When Unchanged is returned, version stays same, enabling safe downstream optimization
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
     * @type {Map<string, {output: string, inputs: string[], computor: (inputs: DatabaseValue[], oldValue: DatabaseValue | undefined) => DatabaseValue | Unchanged}>}
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
     * Index helper for managing persistent reverse dependencies and inputs.
     * @private
     * @type {Index}
     */
    index;

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
     * Sets a specific node's value, incrementing its version.
     * All operations are performed atomically in a single batch.
     * @param {string} key - The name of the node to set
     * @param {DatabaseValue} value - The value to set
     * @returns {Promise<void>}
     */
    /**
     * Sets a specific node's value, marking it up-to-date and propagating potentially-outdated to dependents.
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

        // Ensure node exists (will create from pattern if needed, allow pass-through for constants)
        const nodeDefinition = await this.getOrCreateConcreteNode(canonicalKey, true);

        // Validate that this is a source node (no inputs)
        // Source nodes are either external (no schema) or have empty inputs array
        if (nodeDefinition.inputs.length > 0) {
            throw makeInvalidSetError(canonicalKey);
        }

        /** @type {Array<{type: "put", key: string, value: DatabaseStoredValue} | {type: "del", key: string}>} */
        const batchOperations = [];

        // Ensure node is indexed (if it has inputs)
        if (nodeDefinition.inputs.length > 0) {
            await this.index.ensureNodeIndexed(
                canonicalKey,
                nodeDefinition.inputs,
                batchOperations
            );
        }

        // Store the value
        batchOperations.push(this.putOp(canonicalKey, value));

        // Increment version
        const currentVersion = await this.database.getVersion(versionKey(canonicalKey)) || 0;
        batchOperations.push(
            this.putOp(versionKey(canonicalKey), currentVersion + 1)
        );

        // Store empty dependency versions (source nodes have no dependencies)
        batchOperations.push(
            this.putOp(depVersionsKey(canonicalKey), makeDependencyVersions({}))
        );

        // Mark this key as up-to-date
        /** @type {import('./types').Freshness} */
        const upToDate = "up-to-date";
        batchOperations.push(
            this.putOp(freshnessKey(canonicalKey), upToDate)
        );

        // Collect operations to mark all dependents as potentially-outdated
        await this.collectMarkDependentsOperations(canonicalKey, batchOperations);

        // Execute all operations atomically
        await this.database.batch(batchOperations);
    }

    /**
     * Recursively collects operations to mark dependent nodes as potentially-outdated.
     * Uses both static dependents map and DB-persisted reverse dependencies.
     * @private
     * @param {string} changedKey - The key that was changed
     * @param {Array<{type: "put", key: string, value: DatabaseStoredValue} | {type: "del", key: string}>} batchOperations - Batch to add operations to
     * @param {Set<string>} visited - Set of already-visited nodes to prevent redundant recursion
     * @returns {Promise<void>}
     */
    async collectMarkDependentsOperations(changedKey, batchOperations, visited = new Set()) {
        // Avoid redundant work
        if (visited.has(changedKey)) {
            return;
        }
        visited.add(changedKey);

        // Collect dependents from both static map and DB
        const staticDependents = this.dependentsMap.get(changedKey) || [];
        const dynamicDependents = await this.index.listDependents(changedKey);

        // Combine both sources
        const allDependents = [
            ...staticDependents,
            ...dynamicDependents.map((output) => ({ output, inputs: [] })),
        ];

        for (const node of allDependents) {
            const currentFreshness = await this.database.getFreshness(
                freshnessKey(node.output)
            );

            // Only update if not already potentially-outdated
            if (currentFreshness !== "potentially-outdated") {
                /** @type {import('./types').Freshness} */
                const potentiallyOutdated = "potentially-outdated";
                batchOperations.push(
                    this.putOp(
                        freshnessKey(node.output),
                        potentiallyOutdated
                    )
                );

                // Recursively mark dependents of this node
                await this.collectMarkDependentsOperations(
                    node.output,
                    batchOperations,
                    visited
                );
            }
        }
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
            // Multiple patterns match - this is ambiguous
            const patternList = matches
                .map((m) => `'${m.compiledNode.canonicalOutput}'`)
                .join(", ");
            throw makeInvalidSchemaError(
                `Ambiguous match: concrete key '${concreteKeyCanonical}' matches multiple patterns: ${patternList}`,
                concreteKeyCanonical
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
            // For atom nodes, create pass-through if allowed
            const expr = parseExpr(concreteKeyCanonical);
            
            if (expr.kind === "atom" && allowPassThrough) {
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

        // Compute schema hash for namespacing DB keys
        // Use a stable canonical representation of the schema
        const schemaRepresentation = compiledNodes
            .map((node) => ({
                output: node.canonicalOutput,
                inputs: node.canonicalInputs,
                head: node.head,
                arity: node.arity,
                isPattern: node.isPattern,
            }))
            .sort((a, b) => a.output.localeCompare(b.output));
        
        const schemaJson = JSON.stringify(schemaRepresentation);
        this.schemaHash = crypto
            .createHash("sha256")
            .update(schemaJson)
            .digest("hex")
            .substring(0, 16); // Use first 16 chars for brevity

        // Initialize index helper
        this.index = makeIndex(database, this.schemaHash);

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

        // Pre-compute reverse dependency map for static edges only
        this.dependentsMap = new Map();
        this.calculateDependents();
    }

    /**
     * Checks if a node is up-to-date by comparing dependency versions.
     * A node is up-to-date if all its dependencies have the same versions
     * as when the node was last computed.
     *
     * @private
     * @param {string} nodeName - The node to check
     * @param {Array<string>} inputs - The node's input dependencies
     * @returns {Promise<boolean>}
     */
    /**
     * Checks if a node is up-to-date using LOCAL information only.
     * Does NOT pull or access dependencies - uses only stored metadata.
     * 
     * A node is up-to-date if:
     * 1. It's marked as "up-to-date" (freshness flag), OR
     * 2. It's "potentially-outdated" BUT all dependency versions match the stored snapshot
     *
     * @private
     * @param {string} nodeName - The node to check
     * @param {Array<string>} inputs - The node's input dependencies
     * @returns {Promise<boolean>}
     */
    async isNodeUpToDate(nodeName, inputs) {
        // Check freshness flag first
        const freshness = await this.database.getFreshness(freshnessKey(nodeName));
        
        // If marked as up-to-date, it's up-to-date
        if (freshness === "up-to-date") {
            return true;
        }

        // If not potentially-outdated (e.g., undefined/never computed), not up-to-date
        if (freshness !== "potentially-outdated") {
            return false;
        }

        // Node is potentially-outdated - check if dependency versions still match
        const storedDepVersions = await this.database.getDependencyVersions(
            depVersionsKey(nodeName)
        );

        // If no stored versions, node has never been computed
        if (!storedDepVersions) {
            return false;
        }

        // Check if all inputs have the same versions as stored
        for (const inputKey of inputs) {
            const currentVersion = await this.database.getVersion(versionKey(inputKey));
            const storedVersion = storedDepVersions.versions[inputKey];

            // If input has no version or versions don't match, not up-to-date
            if (currentVersion === undefined || storedVersion === undefined || 
                currentVersion !== storedVersion) {
                return false;
            }
        }

        return true;
    }

    /**
     * Pulls a specific node's value, lazily evaluating dependencies as needed.
     *
     * Algorithm:
     * - Check locally if node is up-to-date (without pulling dependencies)
     * - If up-to-date: return cached value (fast path)
     * - If not up-to-date: pull dependencies, recompute, handle Unchanged
     *
     * @param {string} nodeName - The name of the node to pull
     * @returns {Promise<DatabaseValue>} The node's value
     */
    async pull(nodeName) {
        // Canonicalize the node name
        const canonicalName = canonicalize(nodeName);

        // Validate that key is concrete (no variables)
        validateConcreteKey(canonicalName);

        // Find or create the node definition
        const nodeDefinition = await this.getOrCreateConcreteNode(canonicalName);

        // Check LOCALLY if node is up-to-date (doesn't pull dependencies)
        const upToDate = await this.isNodeUpToDate(canonicalName, nodeDefinition.inputs);

        if (upToDate) {
            // Node is up-to-date, return cached value immediately
            const result = await this.database.getValue(canonicalName);
            if (result === undefined) {
                throw makeMissingValueError(canonicalName);
            }
            return result;
        }

        // Not up-to-date - need to pull dependencies and recompute
        return await this.maybeRecalculate(nodeDefinition);
    }

    /**
     * Maybe recalculates a potentially-outdated node.
     * Pulls all inputs, computes, and handles Unchanged appropriately.
     *
     * @private
     * @param {{output: string, inputs: string[], computor: (inputs: DatabaseValue[], oldValue: DatabaseValue | undefined) => DatabaseValue | Unchanged}} nodeDefinition - The node to recalculate
     * @returns {Promise<DatabaseValue>}
     */
    async maybeRecalculate(nodeDefinition) {
        const nodeName = nodeDefinition.output;

        // Pull all inputs (recursively ensures they're up-to-date)
        const inputValues = [];
        for (const inputKey of nodeDefinition.inputs) {
            await this.getOrCreateConcreteNode(inputKey, true);
            const inputValue = await this.pull(inputKey);
            inputValues.push(inputValue);
        }

        // Get old value
        const oldValue = await this.database.getValue(nodeName);

        // Compute new value
        const computedValue = nodeDefinition.computor(inputValues, oldValue);

        // Freshness constants
        /** @type {import('./types').Freshness} */
        const FRESHNESS_UP_TO_DATE = "up-to-date";

        // Prepare batch operations
        /** @type {Array<{type: "put", key: string, value: DatabaseStoredValue} | {type: "del", key: string}>} */
        const batchOperations = [];

        // Ensure node is indexed
        if (nodeDefinition.inputs.length > 0) {
            await this.index.ensureNodeIndexed(
                nodeName,
                nodeDefinition.inputs,
                batchOperations
            );
        }

        // Mark all inputs as up-to-date (they were just pulled)
        for (const inputKey of nodeDefinition.inputs) {
            batchOperations.push(
                this.putOp(freshnessKey(inputKey), FRESHNESS_UP_TO_DATE)
            );
        }

        // Collect current dependency versions
        /** @type {Record<string, Version>} */
        const currentDepVersionsMap = {};
        for (const inputKey of nodeDefinition.inputs) {
            const inputVersion = await this.database.getVersion(versionKey(inputKey));
            if (inputVersion !== undefined) {
                currentDepVersionsMap[inputKey] = inputVersion;
            }
        }

        // Store dependency versions snapshot
        batchOperations.push(
            this.putOp(depVersionsKey(nodeName), makeDependencyVersions(currentDepVersionsMap))
        );

        if (!isUnchanged(computedValue)) {
            // Value changed: store it, increment version, mark up-to-date
            batchOperations.push(this.putOp(nodeName, computedValue));
            
            const currentVersion = await this.database.getVersion(versionKey(nodeName)) || 0;
            batchOperations.push(
                this.putOp(versionKey(nodeName), currentVersion + 1)
            );

            batchOperations.push(
                this.putOp(freshnessKey(nodeName), FRESHNESS_UP_TO_DATE)
            );
        } else {
            // Value unchanged: don't update value or version, but mark up-to-date
            // Version stays same - this enables safe downstream optimization
            batchOperations.push(
                this.putOp(freshnessKey(nodeName), FRESHNESS_UP_TO_DATE)
            );
        }

        // Execute all operations atomically
        await this.database.batch(batchOperations);

        // Return the current value
        const result = await this.database.getValue(nodeName);
        if (result === undefined) {
            throw makeMissingValueError(nodeName);
        }
        return result;
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
