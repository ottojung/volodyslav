/**
 * Schema validation and compilation utilities.
 */

const { parseExpr } = require("./expr");
const { makeInvalidSchemaError } = require("./errors");
const { patternsCanUnify } = require("./unify");

/** @typedef {import('./types').Schema} Schema */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */

/**
 * Validates that all tokens used in inputs appear in the output.
 * This ensures no unbound variables exist.
 * Variables are automatically derived from output expression arguments.
 *
 * @param {Schema} schema
 * @throws {Error} If validation fails
 */
function validateSchemaVariables(schema) {
    // Parse the output to derive variables from output expression
    const outputExpr = parseExpr(schema.output);
    const outputTokens = new Set();

    if (outputExpr.kind === "call") {
        for (const arg of outputExpr.args) {
            outputTokens.add(arg);
        }
    }

    // Parse all inputs and check that all tokens are in output
    for (const input of schema.inputs) {
        const inputExpr = parseExpr(input);
        if (inputExpr.kind === "call") {
            for (const arg of inputExpr.args) {
                // All input args must be in output to avoid unbound variables
                if (!outputTokens.has(arg)) {
                    throw makeInvalidSchemaError(
                        `Input variable '${arg}' is not present in output pattern`,
                        schema.output
                    );
                }
            }
        }
    }
}

/**
 * Compiled schema with parsed expressions for efficient matching.
 * @typedef {Object} CompiledSchema
 * @property {Schema} schema - The original schema
 * @property {ParsedExpr} outputExpr - Parsed output expression
 * @property {string} head - The head/name of the output
 * @property {number} arity - Number of arguments in the output
 */

/**
 * Compiles a schema by parsing its output expression.
 *
 * @param {Schema} schema
 * @returns {CompiledSchema}
 */
function compileSchema(schema) {
    const outputExpr = parseExpr(schema.output);

    const head = outputExpr.name;
    const arity = outputExpr.args.length;

    return {
        schema,
        outputExpr,
        head,
        arity,
    };
}

/**
 * Checks if two compiled nodes with patterns can potentially match the same concrete nodes.
 * Uses unification-based check that respects repeated-variable constraints.
 *
 * @param {CompiledNode} node1
 * @param {CompiledNode} node2
 * @returns {boolean} True if nodes overlap
 */
function nodesOverlap(node1, node2) {
    // Must have same head and arity to overlap
    if (node1.head !== node2.head || node1.arity !== node2.arity) {
        return false;
    }

    // Use pattern-pattern unification
    return patternsCanUnify(
        node1.outputExpr,
        node1.variables,
        node2.outputExpr,
        node2.variables
    );
}

/**
 * Validates that compiled nodes don't have overlapping patterns.
 *
 * @param {Array<CompiledNode>} compiledNodes
 * @throws {Error} If nodes overlap
 */
function validateNoNodeOverlap(compiledNodes) {
    // Only check pattern nodes for overlap
    const patternNodes = compiledNodes.filter((node) => node.isPattern);

    for (let i = 0; i < patternNodes.length; i++) {
        for (let j = i + 1; j < patternNodes.length; j++) {
            const node1 = patternNodes[i];
            const node2 = patternNodes[j];
            if (node1 === undefined || node2 === undefined) {
                throw new Error("Unexpected undefined node in validation");
            }
            if (nodesOverlap(node1, node2)) {
                throw makeInvalidSchemaError(
                    `Overlaps with pattern '${node2.outputCanonical}'`,
                    node1.outputCanonical
                );
            }
        }
    }
}

/**
 * Validates that schemas don't have overlapping patterns.
 * Backwards compatibility wrapper - derives variables from output expressions.
 *
 * @param {Array<CompiledSchema>} compiledSchemas
 * @throws {Error} If schemas overlap
 */
function validateNoSchemaOverlap(compiledSchemas) {
    for (let i = 0; i < compiledSchemas.length; i++) {
        for (let j = i + 1; j < compiledSchemas.length; j++) {
            const schema1 = compiledSchemas[i];
            const schema2 = compiledSchemas[j];
            if (schema1 === undefined || schema2 === undefined) {
                throw new Error("Unexpected undefined schema in validation");
            }
            
            // Derive variables from output expressions
            const vars1 = new Set();
            if (schema1.outputExpr.kind === "call") {
                for (const arg of schema1.outputExpr.args) {
                    vars1.add(arg);
                }
            }
            
            const vars2 = new Set();
            if (schema2.outputExpr.kind === "call") {
                for (const arg of schema2.outputExpr.args) {
                    vars2.add(arg);
                }
            }
            
            if (patternsCanUnify(schema1.outputExpr, vars1, schema2.outputExpr, vars2)) {
                throw makeInvalidSchemaError(
                    `Overlaps with schema '${schema2.schema.output}'`,
                    schema1.schema.output
                );
            }
        }
    }
}

module.exports = {
    validateSchemaVariables,
    compileSchema,
    validateNoSchemaOverlap,
    validateNoNodeOverlap,
};
