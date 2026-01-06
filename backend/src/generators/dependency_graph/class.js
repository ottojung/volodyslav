/**
 * DependencyGraph class for propagating data through dependency edges.
 */

const { schemaPatternToString, stringToNodeName } = require("./database");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').FreshnessStatus} FreshnessStatus */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').SchemaPattern} SchemaPattern */
/** @typedef {import('./types').SchemaHash} SchemaHash */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {import('./graph_storage').GraphStorage} GraphStorage */
/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./node_key').NodeKey} NodeKey */
/** @typedef {import('./types').ConcreteNodeComputor} ConcreteNodeComputor */

const crypto = require("crypto");
const { isUnchanged } = require("./unchanged");
const {
    makeInvalidNodeError,
    makeMissingValueError,
    makeInvalidSetError,
    makeInvalidComputorReturnValueError,
    makeArityMismatchError,
} = require("./errors");
const {
    compileNodeDef,
    validateNoOverlap,
    validateAcyclic,
    validateSingleArityPerHead,
} = require("./compiled_node");
const {
    createVariablePositionMap,
    extractInputBindings,
} = require("./compiled_node");
const { renderExpr } = require("./expr");
const { deserializeNodeKey } = require("./node_key");

const { makeGraphStorage } = require("./graph_storage");
const { createNodeKeyFromPattern, serializeNodeKey } = require("./node_key");
const { stringToSchemaHash } = require("./database");

/**
 * DependencyGraph class for propagating data through dependency edges.
 *
 * Node Identity:
 * - Concrete nodes use JSON key format: {nodeName: NodeName, args: Array<ConstValue>}
 * - Example: derived(x) with bindings ["test"] → {"head":"derived","args":["test"]}
 * - Pattern names (e.g., "event(e)") are only used for schema definitions
 * - Actual node instances are identified by serialized JSON keys
 *
 * Bindings:
 * - pull(nodeName, bindings) accepts optional bindings: Array<ConstValue>
 * - Bindings are any JSON-serializable values (primitives or objects)
 * - Different bindings create separate cached instances
 * - Computors receive bindings as third parameter
 *
 * Algorithm overview:
 * - pull() checks freshness: up-to-date → return cached, potentially-outdated → maybeRecalculate
 * - maybeRecalculate() pulls all inputs, computes, marks up-to-date
 * - When Unchanged is returned, skips recalculation for the nodes up the call stack
 *
 * Persistence model:
 * - Reverse dependencies and inputs are persisted in DB under schema-namespaced keys
 * - Schema hash ensures old graph schemas don't interfere with new ones
 * - No initialization scan needed; edges are queryable on demand from DB
 */
class DependencyGraphClass {
    /**
     * Index for fast lookup by nodeName (node name/functor only).
     * Maps nodeName to the single CompiledNode with that functor.
     * @private
     * @type {Map<NodeName, CompiledNode>}
     */
    headIndex;

    /**
     * Cache of concrete instantiated nodes created from patterns on demand.
     * Maps canonical output to a runtime node with concrete inputs and wrapped computor.
     * @private
     * @type {Map<NodeKeyString, ConcreteNode>}
     */
    concreteInstantiations;

    /**
     * Stable hash of the schema (compiled nodes).
     * Used to namespace DB keys so different schemas don't interfere.
     * @private
     * @type {SchemaHash}
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
     * @param {NodeKeyString} changedKey - The key that was changed
     * @param {BatchBuilder} batch - Batch builder to add operations to
     * @param {Set<NodeKeyString>} nodesBecomingOutdated - Set of nodes that are becoming outdated in this batch
     * @returns {Promise<void>}
     */
    async propagateOutdated(
        changedKey,
        batch,
        nodesBecomingOutdated = new Set()
    ) {
        const dynamicDependents = await this.storage.listDependents(changedKey);
        for (const output of dynamicDependents) {
            // Optimization: if already marked outdated in this batch, skip
            if (nodesBecomingOutdated.has(output)) {
                continue;
            }

            const currentFreshness = await this.storage.freshness.get(output);

            if (currentFreshness === "up-to-date") {
                batch.freshness.put(output, "potentially-outdated");
                nodesBecomingOutdated.add(output);

                // Recursively mark dependents of this node
                await this.propagateOutdated(
                    output,
                    batch,
                    nodesBecomingOutdated
                );
            } else if (currentFreshness === undefined) {
                // Node not yet materialized, skip
                continue;
            } else if (currentFreshness === "potentially-outdated") {
                // Already potentially-outdated, skip
                continue;
            } else {
                /** @type {never} */
                const x = currentFreshness;
                throw new Error(
                    `Unexpected freshness value ${x} for node ${output}`
                );
            }
        }
    }

    /**
     * Sets a specific node's value, marking it up-to-date and propagating changes.
     * All operations are performed atomically in a single batch.
     * @param {string} nodeName - The node name (functor only, e.g., "full_event")
     * @param {DatabaseValue} value - The value to set
     * @param {Array<ConstValue>} [bindings=[]] - Positional bindings array for parameterized nodes
     * @returns {Promise<void>}
     */
    async set(nodeName, value, bindings = []) {
        const nodeNameTyped = stringToNodeName(nodeName);

        // Lookup schema by nodeName
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeNameTyped);
        }

        // Validate arity matches bindings
        if (compiledNode.arity !== bindings.length) {
            throw makeArityMismatchError(
                nodeNameTyped,
                compiledNode.arity,
                bindings.length
            );
        }

        // Validate that this is a source node (no inputs)
        if (compiledNode.source.inputs.length > 0) {
            throw makeInvalidSetError(nodeNameTyped);
        }

        // Create NodeKey for storage
        const nodeKey = { head: nodeNameTyped, args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);

        // Ensure node exists (will create from pattern if needed)
        const nodeDefinition = this.getOrCreateConcreteNode(
            concreteKey,
            compiledNode,
            bindings
        );

        // Use batch builder for atomic operations
        await this.storage.withBatch(async (batch) => {
            // Store the value
            batch.values.put(nodeDefinition.output, value);

            // Mark this key as up-to-date
            batch.freshness.put(nodeDefinition.output, "up-to-date");

            // Ensure the node is materialized (write inputs record with empty array)
            await this.storage.ensureMaterialized(
                nodeDefinition.output,
                nodeDefinition.inputs,
                batch
            );

            // Collect operations to mark all dependents as potentially-outdated
            await this.propagateOutdated(nodeDefinition.output, batch);
        });
    }

    /**
     * Gets or creates a concrete node instantiation.
     * Dynamic edges are persisted to DB when the node is computed/set, not here.
     * This is a runtime-only function that operates on instance data, not schema patterns.
     * @private
     * @param {NodeKeyString} concreteKeyCanonical - Canonical concrete node key (NodeKeyString)
     * @param {CompiledNode} compiledNode - The compiled node definition
     * @param {Array<ConstValue>} bindings - Positional bindings for this instance
     * @returns {ConcreteNode}
     * @throws {Error} If pattern matching fails
     */
    getOrCreateConcreteNode(concreteKeyCanonical, compiledNode, bindings) {
        const concreteKeyString = concreteKeyCanonical;

        // Check instantiation cache
        const cached = this.concreteInstantiations.get(concreteKeyString);
        if (cached) {
            return cached;
        }

        // If it's not a pattern (arity 0 or no variables), create simple concrete node
        if (!compiledNode.isPattern) {
            // Convert all inputs to JSON format
            const jsonInputs = compiledNode.canonicalInputs.map((input) => {
                const inputKey = createNodeKeyFromPattern(input, []);
                const serialized = serializeNodeKey(inputKey);
                return serialized;
            });

            const concreteNode = {
                output: concreteKeyString,
                inputs: jsonInputs,
                /**
                 * @type {ConcreteNodeComputor}
                 */
                computor: (inputs, oldValue) => {
                    return compiledNode.source.computor(inputs, oldValue, []);
                },
            };

            // Cache it
            this.concreteInstantiations.set(concreteKeyString, concreteNode);
            return concreteNode;
        }

        // Create variable position map from output pattern
        const varToPosition = createVariablePositionMap(
            compiledNode.outputExpr
        );

        // Instantiate inputs by extracting appropriate positional bindings
        const concreteInputs = compiledNode.inputExprs.map((inputExpr) => {
            // Extract bindings for this input based on variable name mapping
            const inputBindings = extractInputBindings(
                inputExpr,
                bindings,
                varToPosition
            );

            // Create node key with positional bindings
            const inputPattern = renderExpr(inputExpr);
            const inputKey = createNodeKeyFromPattern(
                inputPattern,
                inputBindings
            );
            const serialized = serializeNodeKey(inputKey);
            return serialized;
        });

        // Create concrete node with wrapper computor
        const concreteNode = {
            output: concreteKeyString,
            inputs: concreteInputs,
            /**
             * @type {ConcreteNodeComputor}
             */
            computor: (inputValues, oldValue) =>
                compiledNode.source.computor(inputValues, oldValue, bindings),
        };

        // Cache it
        this.concreteInstantiations.set(concreteKeyString, concreteNode);

        // Dynamic edges will be persisted to DB when this node is computed or set

        return concreteNode;
    }

    /**
     * @constructor
     * @param {RootDatabase} rootDatabase - The root database instance
     * @param {Array<NodeDef>} nodeDefs - Unified node definitions
     */
    constructor(rootDatabase, nodeDefs) {
        // Compile all node definitions
        const compiledNodes = nodeDefs.map(compileNodeDef);

        // Validate no overlaps
        validateNoOverlap(compiledNodes);

        // Validate acyclic
        validateAcyclic(compiledNodes);

        // Validate single arity per head (new requirement)
        validateSingleArityPerHead(compiledNodes);

        // Compute schema hash for namespacing DB keys
        // Use a stable canonical representation of the schema
        const schemaRepresentation = compiledNodes
            .map((node) => ({
                output: renderExpr(node.outputExpr),
                inputs: node.inputExprs.map(renderExpr),
            }))
            .sort((a, b) =>
                schemaPatternToString(a.output).localeCompare(
                    schemaPatternToString(b.output)
                )
            );

        const schemaJson = JSON.stringify(schemaRepresentation);
        const hash = crypto
            .createHash("sha256")
            .update(schemaJson)
            .digest("hex");
        this.schemaHash = stringToSchemaHash(hash);

        // Initialize storage helper
        this.storage = makeGraphStorage(rootDatabase, this.schemaHash);

        // Build nodeName index for O(1) lookup by nodeName (functor) only
        this.headIndex = new Map();
        for (const compiled of compiledNodes) {
            this.headIndex.set(compiled.head, compiled);
        }

        // Initialize instantiation cache
        this.concreteInstantiations = new Map();
    }

    /**
     * Maybe recalculates a potentially-outdated node.
     * If all inputs are up-to-date, returns cached value.
     * Otherwise, recalculates.
     * Special optimization: if computation returns Unchanged, propagate up-to-date downstream.
     *
     * @private
     * @param {ConcreteNode} nodeDefinition - The node to maybe recalculate
     * @param {BatchBuilder} batch - Batch builder for atomic operations
     * @returns {Promise<RecomputeResult>}
     */
    async maybeRecalculate(nodeDefinition, batch) {
        const nodeKey = nodeDefinition.output;

        // Pull all inputs (recursively ensures they're up-to-date)
        const inputValues = [];
        let allInputsUnchanged = true;

        for (const inputKey of nodeDefinition.inputs) {
            const { value: inputValue, status: inputStatus } =
                await this.pullByNodeKeyStringWithStatus(inputKey);
            inputValues.push(inputValue);

            // If input is NOT 'unchanged', we can't guarantee we are unchanged.
            // 'cached' inputs might have changed since we last ran.
            // 'changed' inputs definitely changed.
            if (inputStatus !== "unchanged") {
                allInputsUnchanged = false;
            }
        }

        // Get old value
        const oldValue = await this.storage.values.get(nodeKey);

        // Optimization: if all inputs are 'unchanged' (meaning they were outdated but recomputed to same value),
        // then we can skip recomputation and mark ourselves up-to-date.
        // However, we must still ensure the node is indexed for correct invalidation.
        if (
            allInputsUnchanged &&
            nodeDefinition.inputs.length > 0 &&
            oldValue !== undefined
        ) {
            // Ensure node is materialized
            await this.storage.ensureMaterialized(
                nodeKey,
                nodeDefinition.inputs,
                batch
            );

            // Ensure reverse dependencies are indexed (if it has inputs)
            // This is critical for pattern nodes which have no static dependents map entry
            await this.storage.ensureReverseDepsIndexed(
                nodeKey,
                nodeDefinition.inputs,
                batch
            );

            // Mark up-to-date
            batch.freshness.put(nodeKey, "up-to-date");

            return { value: oldValue, status: "unchanged" };
        }

        // Compute new value
        const computedValue = await nodeDefinition.computor(
            inputValues,
            oldValue
        );

        // Validate that computor returned a valid value
        if (isUnchanged(computedValue)) {
            // Must have a previous value
            if (oldValue === undefined) {
                throw makeInvalidComputorReturnValueError(
                    deserializeNodeKey(nodeKey).head,
                    "Unchanged (but no previous value exists)"
                );
            }
        } else {
            // Must be a valid DatabaseValue (not null/undefined)
            if (computedValue === null || computedValue === undefined) {
                throw makeInvalidComputorReturnValueError(
                    deserializeNodeKey(nodeKey).head,
                    computedValue
                );
            }
        }

        // Always ensure node is materialized (even with 0 inputs)
        await this.storage.ensureMaterialized(
            nodeKey,
            nodeDefinition.inputs,
            batch
        );

        // Ensure reverse dependencies are indexed (only if it has inputs)
        if (nodeDefinition.inputs.length > 0) {
            await this.storage.ensureReverseDepsIndexed(
                nodeKey,
                nodeDefinition.inputs,
                batch
            );
        }

        // Mark all inputs as up-to-date (redundant but safe)
        for (const inputKey of nodeDefinition.inputs) {
            batch.freshness.put(inputKey, "up-to-date");
        }

        if (isUnchanged(computedValue)) {
            // Mark up-to-date
            batch.freshness.put(nodeKey, "up-to-date");

            // Return old value (must exist if Unchanged returned)
            const result = await this.storage.values.get(nodeKey);
            if (result === undefined) {
                throw makeMissingValueError(deserializeNodeKey(nodeKey).head);
            }
            return { value: result, status: "unchanged" };
        } else {
            // Store value, mark up-to-date
            batch.values.put(nodeKey, computedValue);
            batch.freshness.put(nodeKey, "up-to-date");
            return { value: computedValue, status: "changed" };
        }
    }

    /**
     * Pulls a specific node's value, lazily evaluating dependencies as needed.
     *
     * Algorithm:
     * - If node is up-to-date: return cached value (fast path)
     * - If node is potentially-outdated: maybe recalculate (check inputs first)
     *
     * @param {string} nodeName - The node name (functor only, e.g., "full_event")
     * @param {Array<ConstValue>} [bindings=[]] - Positional bindings array for parameterized nodes
     * @returns {Promise<DatabaseValue>} The node's value
     */
    async pull(nodeName, bindings = []) {
        const nodeNameValue = stringToNodeName(nodeName);
        const { value } = await this.pullWithStatus(nodeNameValue, bindings);
        return value;
    }

    /**
     * Internal pull that returns status for optimization.
     * Accepts nodeName-only string from public API.
     * @private
     * @param {NodeName} nodeName - The node name (functor only)
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<RecomputeResult>}
     */
    async pullWithStatus(nodeName, bindings = []) {
        return this.storage.withBatch(async (batch) => {
            // Lookup schema by nodeName
            const compiledNode = this.headIndex.get(nodeName);
            if (!compiledNode) {
                throw makeInvalidNodeError(nodeName);
            }

            // Validate arity matches bindings
            if (compiledNode.arity !== bindings.length) {
                throw makeArityMismatchError(
                    nodeName,
                    compiledNode.arity,
                    bindings.length
                );
            }

            // Create NodeKey for storage
            const nodeKey = { head: nodeName, args: bindings };
            const concreteKey = serializeNodeKey(nodeKey);

            // Find or create the node definition
            const nodeDefinition = this.getOrCreateConcreteNode(
                concreteKey,
                compiledNode,
                bindings
            );

            // Check freshness of this node
            const nodeFreshness = await this.storage.freshness.get(
                nodeDefinition.output
            );

            // Fast path: if up-to-date, return cached value immediately
            // But first ensure the node is materialized (for seeded DBs or restart resilience)
            if (nodeFreshness === "up-to-date") {
                // Ensure node is materialized
                await this.storage.ensureMaterialized(
                    nodeDefinition.output,
                    nodeDefinition.inputs,
                    batch
                );

                // Ensure reverse dependencies are indexed if it has inputs
                // This is critical for seeded databases where values/freshness exist
                // but reverse-dep metadata is missing
                if (nodeDefinition.inputs.length > 0) {
                    await this.storage.ensureReverseDepsIndexed(
                        nodeDefinition.output,
                        nodeDefinition.inputs,
                        batch
                    );
                }

                const result = await this.storage.values.get(
                    nodeDefinition.output
                );
                if (result === undefined) {
                    throw makeMissingValueError(
                        deserializeNodeKey(nodeDefinition.output).head
                    );
                }
                return { value: result, status: "cached" };
            }

            // Potentially-outdated or undefined freshness: need to maybe recalculate
            return await this.maybeRecalculate(nodeDefinition, batch);
        });
    }

    /**
     * Internal pull by NodeKey string (for recursive calls within the graph).
     * Accepts serialized NodeKey JSON string.
     * @private
     * @param {NodeKeyString} nodeKeyStr - Serialized NodeKey JSON string
     * @returns {Promise<RecomputeResult>}
     */
    async pullByNodeKeyStringWithStatus(nodeKeyStr) {
        return this.storage.withBatch(async (batch) => {
            const nodeKey = deserializeNodeKey(nodeKeyStr);
            const nodeName = nodeKey.head;
            const bindings = nodeKey.args;

            // Lookup schema by nodeName
            const compiledNode = this.headIndex.get(nodeName);
            if (!compiledNode) {
                throw makeInvalidNodeError(nodeName);
            }

            // Validate arity matches bindings
            if (compiledNode.arity !== bindings.length) {
                throw makeArityMismatchError(
                    nodeName,
                    compiledNode.arity,
                    bindings.length
                );
            }

            // Find or create the node definition
            const nodeDefinition = this.getOrCreateConcreteNode(
                nodeKeyStr,
                compiledNode,
                bindings
            );

            // Check freshness of this node
            const nodeFreshness = await this.storage.freshness.get(nodeKeyStr);

            // Fast path: if up-to-date, return cached value immediately
            // But first ensure the node is materialized (for seeded DBs or restart resilience)
            if (nodeFreshness === "up-to-date") {
                // Ensure node is materialized
                await this.storage.ensureMaterialized(
                    nodeKeyStr,
                    nodeDefinition.inputs,
                    batch
                );

                // Ensure reverse dependencies are indexed if it has inputs
                // This is critical for seeded databases where values/freshness exist
                // but reverse-dep metadata is missing
                if (nodeDefinition.inputs.length > 0) {
                    await this.storage.ensureReverseDepsIndexed(
                        nodeKeyStr,
                        nodeDefinition.inputs,
                        batch
                    );
                }

                const result = await this.storage.values.get(nodeKeyStr);
                if (result === undefined) {
                    throw makeMissingValueError(
                        deserializeNodeKey(nodeKeyStr).head
                    );
                }
                return { value: result, status: "cached" };
            }

            // Potentially-outdated or undefined freshness: need to maybe recalculate
            return await this.maybeRecalculate(nodeDefinition, batch);
        });
    }

    /**
     * Query conceptual freshness state of a node (debug interface).
     * @param {NodeName} nodeName - The node name (functor only)
     * @param {Array<ConstValue>} [bindings=[]] - Positional bindings array for parameterized nodes
     * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
     */
    async debugGetFreshness(nodeName, bindings = []) {
        // Lookup schema to validate nodeName and get arity
        const compiledNode = this.headIndex.get(nodeName);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeName);
        }

        // Validate arity
        if (compiledNode.arity !== bindings.length) {
            throw makeArityMismatchError(
                nodeName,
                compiledNode.arity,
                bindings.length
            );
        }

        // Convert to JSON format key
        const nodeKey = { head: nodeName, args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);

        const concreteKeyString = concreteKey;

        const freshness = await this.storage.freshness.get(concreteKeyString);
        if (freshness === undefined) {
            return "missing";
        }
        return freshness;
    }

    /**
     * List all materialized nodes (canonical names).
     * @returns {Promise<NodeKeyString[]>}
     */
    async debugListMaterializedNodes() {
        return this.storage.listMaterializedNodes();
    }

    /**
     * Get the GraphStorage instance for testing purposes.
     * This allows tests to directly access and manipulate the storage.
     * @returns {GraphStorage}
     */
    getStorage() {
        return this.storage;
    }

    /**
     * Get the schema hash for testing purposes.
     * @returns {SchemaHash}
     */
    getSchemaHash() {
        return this.schemaHash;
    }
}

/**
 * Factory function to create a DependencyGraph instance.
 *
 * @param {RootDatabase} rootDatabase - The root database instance
 * @param {Array<NodeDef>} nodeDefs - Unified node definitions
 * @returns {DependencyGraphClass}
 */
function makeDependencyGraph(rootDatabase, nodeDefs) {
    return new DependencyGraphClass(rootDatabase, nodeDefs);
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
