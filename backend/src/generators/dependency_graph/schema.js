/**
 * Schema validation and compilation utilities.
 * This module provides compatibility with the old Schema type.
 * New code should use compiled_node.js directly with NodeDef type.
 */

const { parseExpr } = require("./expr");
const { makeInvalidSchemaError } = require("./errors");
const { schemaToNodeDef } = require("./migration");
const { compileNodeDef, patternsCanOverlap } = require("./compiled_node");

/** @typedef {import('./types').Schema} Schema */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */

/**
 * Validates that all variables used in inputs are declared in the schema's variables list
 * and that the output variables cover all input variables.
 *
 * @param {Schema} schema
 * @throws {Error} If validation fails
 */
function validateSchemaVariables(schema) {
    const declaredVars = new Set(schema.variables);

    // Parse the output to find which variables are in the output
    const outputExpr = parseExpr(schema.output);
    const outputVars = new Set();

    if (outputExpr.kind === "call") {
        for (const arg of outputExpr.args) {
            // With new grammar, args are ParsedArg objects
            if (arg.kind === "identifier" && declaredVars.has(arg.value)) {
                outputVars.add(arg.value);
            }
        }
    }

    // Parse all inputs and collect variables
    const inputVars = new Set();
    for (const input of schema.inputs) {
        const inputExpr = parseExpr(input);
        if (inputExpr.kind === "call") {
            for (const arg of inputExpr.args) {
                if (arg.kind === "identifier" && declaredVars.has(arg.value)) {
                    inputVars.add(arg.value);
                }
            }
        }
    }

    // Check that all input variables are in the output variables
    for (const inputVar of inputVars) {
        if (!outputVars.has(inputVar)) {
            throw makeInvalidSchemaError(
                `Input variable '${inputVar}' is not present in output pattern`,
                schema.output
            );
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
 * Uses the new CompiledNode infrastructure internally.
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
 * Checks if two schemas can potentially match the same concrete nodes.
 * Uses the new pattern overlap detection.
 *
 * @param {CompiledSchema} schema1
 * @param {CompiledSchema} schema2
 * @returns {boolean} True if schemas overlap
 */
function schemasOverlap(schema1, schema2) {
    // Convert to CompiledNode and use the new overlap detection
    const nodeDef1 = schemaToNodeDef(schema1.schema);
    const nodeDef2 = schemaToNodeDef(schema2.schema);
    
    const compiled1 = compileNodeDef(nodeDef1);
    const compiled2 = compileNodeDef(nodeDef2);
    
    return patternsCanOverlap(compiled1, compiled2);
}

/**
 * Validates that schemas don't have overlapping patterns.
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
            if (schemasOverlap(schema1, schema2)) {
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
};
