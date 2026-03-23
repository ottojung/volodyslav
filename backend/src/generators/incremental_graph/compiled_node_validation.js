"use strict";

const {
    makeInvalidSchemaError,
    makeSchemaOverlapError,
    makeSchemaCycleError,
    makeSchemaArityConflictError,
    makeInvalidNodeDefError,
} = require("./errors");

/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */

/**
 * Minimal pattern interface for overlap checking.
 * @typedef {object} PatternForOverlap
 * @property {ParsedExpr} outputExpr - The output expression
 * @property {NodeName} head - Head/name of the pattern
 * @property {number} arity - Number of arguments
 */

/**
 * Checks if two patterns can potentially match the same concrete keys.
 * With constants removed, patterns overlap if and only if they have
 * the same head (functor) and the same arity.
 *
 * @param {PatternForOverlap} node1
 * @param {PatternForOverlap} node2
 * @returns {boolean} True if patterns can overlap
 */
function patternsCanOverlap(node1, node2) {
    return node1.head === node2.head && node1.arity === node2.arity;
}

/**
 * Validates that no two compiled nodes have overlapping patterns.
 * @param {CompiledNode[]} compiledNodes
 * @throws {Error} If patterns overlap
 */
function validateNoOverlap(compiledNodes) {
    for (let i = 0; i < compiledNodes.length; i++) {
        for (let j = i + 1; j < compiledNodes.length; j++) {
            const node1 = compiledNodes[i];
            const node2 = compiledNodes[j];

            if (node1 === undefined || node2 === undefined) {
                throw new Error("Unexpected undefined node in validation");
            }

            if (patternsCanOverlap(node1, node2)) {
                throw makeSchemaOverlapError([
                    node1.canonicalOutput,
                    node2.canonicalOutput,
                ]);
            }
        }
    }
}

/**
 * Validates that the schema graph is acyclic.
 * @param {CompiledNode[]} compiledNodes
 * @throws {Error} If a cycle is detected
 */
function validateAcyclic(compiledNodes) {
    /** @type {Map<CompiledNode, CompiledNode[]>} */
    const adj = new Map();
    for (const node of compiledNodes) {
        adj.set(node, []);
    }

    for (const node of compiledNodes) {
        for (const inputExpr of node.inputExprs) {
            const inputDummy = {
                outputExpr: inputExpr,
                head: inputExpr.name,
                arity: inputExpr.kind === "call" ? inputExpr.args.length : 0,
            };

            for (const potentialDep of compiledNodes) {
                if (patternsCanOverlap(inputDummy, potentialDep)) {
                    const deps = adj.get(node);
                    if (deps) {
                        deps.push(potentialDep);
                    }
                }
            }
        }
    }

    /** @type {Set<CompiledNode>} */
    const visited = new Set();
    /** @type {Set<CompiledNode>} */
    const recursionStack = new Set();

    /**
     * @param {CompiledNode} node
     */
    function dfs(node) {
        visited.add(node);
        recursionStack.add(node);

        const neighbors = adj.get(node) || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                dfs(neighbor);
            } else if (recursionStack.has(neighbor)) {
                throw makeSchemaCycleError([
                    node.canonicalOutput,
                    neighbor.canonicalOutput,
                ]);
            }
        }

        recursionStack.delete(node);
    }

    for (const node of compiledNodes) {
        if (!visited.has(node)) {
            dfs(node);
        }
    }
}

/**
 * Validates that each head has only one arity across all schema outputs.
 * This ensures no arity polymorphism (same head with different arities).
 * @param {CompiledNode[]} compiledNodes
 * @throws {Error} If a head appears with multiple arities
 */
function validateSingleArityPerHead(compiledNodes) {
    /** @type {Map<NodeName, Set<number>>} */
    const headToArities = new Map();

    for (const node of compiledNodes) {
        const head = node.head;

        if (!headToArities.has(head)) {
            headToArities.set(head, new Set());
        }

        const arities = headToArities.get(head);
        if (arities) {
            arities.add(node.arity);
        }
    }

    for (const [head, arities] of headToArities.entries()) {
        if (arities.size > 1) {
            const aritiesArray = Array.from(arities).sort((a, b) => a - b);
            throw makeSchemaArityConflictError(head, aritiesArray);
        }
    }
}

/**
 * Validates that input patterns use the correct arity for their heads.
 * Each input pattern must reference a head with the arity defined by its output pattern.
 * @param {CompiledNode[]} compiledNodes
 * @throws {Error} If an input pattern uses wrong arity for a head
 */
function validateInputArities(compiledNodes) {
    /** @type {Map<NodeName, number>} */
    const headToArity = new Map();

    for (const node of compiledNodes) {
        headToArity.set(node.head, node.arity);
    }

    for (const node of compiledNodes) {
        for (let i = 0; i < node.inputExprs.length; i++) {
            const inputExpr = node.inputExprs[i];
            const inputStr = node.source.inputs[i];
            if (!inputExpr || !inputStr) continue;

            const inputHead = inputExpr.name;
            const inputArity = inputExpr.args.length;
            const expectedArity = headToArity.get(inputHead);

            if (expectedArity === undefined) {
                throw makeInvalidSchemaError(
                    `Input pattern '${inputStr}' references undefined head '${inputHead}'. ` +
                        `Every input pattern must match a schema output pattern.`,
                    node.source.output,
                );
            }

            if (inputArity !== expectedArity) {
                throw makeInvalidSchemaError(
                    `Input pattern '${inputStr}' has arity ${inputArity}, but head '${inputHead}' is defined with arity ${expectedArity}. ` +
                        `All references to the same head must use consistent arity (expected ${expectedArity} arguments)`,
                    node.source.output,
                );
            }
        }
    }
}

/**
 * Validates the structural shape of a single NodeDef entry.
 * Throws InvalidNodeDefError if any required field is missing or has the wrong type.
 * @param {unknown} nodeDef - The candidate node definition
 * @param {number} index - Zero-based index of this entry in the nodeDefs array
 */
function validateNodeDef(nodeDef, index) {
    if (nodeDef === null || typeof nodeDef !== "object" || Array.isArray(nodeDef)) {
        throw makeInvalidNodeDefError(index, "nodeDef", "must be a non-null object");
    }

    if (!("output" in nodeDef) || typeof nodeDef.output !== "string") {
        throw makeInvalidNodeDefError(index, "output", "must be a string");
    }

    if (!("inputs" in nodeDef) || !Array.isArray(nodeDef.inputs) || nodeDef.inputs.some((v) => typeof v !== "string")) {
        throw makeInvalidNodeDefError(index, "inputs", "must be an array of strings");
    }

    if (!("computor" in nodeDef) || typeof nodeDef.computor !== "function") {
        throw makeInvalidNodeDefError(index, "computor", "must be a function");
    }

    if (!("isDeterministic" in nodeDef) || typeof nodeDef.isDeterministic !== "boolean") {
        throw makeInvalidNodeDefError(index, "isDeterministic", "must be a boolean");
    }

    if (!("hasSideEffects" in nodeDef) || typeof nodeDef.hasSideEffects !== "boolean") {
        throw makeInvalidNodeDefError(index, "hasSideEffects", "must be a boolean");
    }
}

module.exports = {
    patternsCanOverlap,
    validateNoOverlap,
    validateAcyclic,
    validateSingleArityPerHead,
    validateInputArities,
    validateNodeDef,
};
