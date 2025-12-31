/**
 * Schema validation and compilation utilities.
 */

const { parseExpr } = require("./expr");
const { makeInvalidSchemaError } = require("./errors");

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
            if (declaredVars.has(arg)) {
                outputVars.add(arg);
            }
        }
    }

    // Parse all inputs and collect variables
    const inputVars = new Set();
    for (const input of schema.inputs) {
        const inputExpr = parseExpr(input);
        if (inputExpr.kind === "call") {
            for (const arg of inputExpr.args) {
                if (declaredVars.has(arg)) {
                    inputVars.add(arg);
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
 * Two schemas overlap if they have the same head and arity, and for every
 * argument position, they don't have conflicting constants.
 *
 * @param {CompiledSchema} schema1
 * @param {CompiledSchema} schema2
 * @returns {boolean} True if schemas overlap
 */
function schemasOverlap(schema1, schema2) {
    // Must have same head and arity to overlap
    if (schema1.head !== schema2.head || schema1.arity !== schema2.arity) {
        return false;
    }

    const vars1 = new Set(schema1.schema.variables);
    const vars2 = new Set(schema2.schema.variables);

    // Check each argument position
    for (let i = 0; i < schema1.arity; i++) {
        const arg1 = schema1.outputExpr.args[i];
        const arg2 = schema2.outputExpr.args[i];
        
        if (arg1 === undefined || arg2 === undefined) {
            throw new Error(`Unexpected undefined argument at position ${i}`);
        }

        const isVar1 = vars1.has(arg1);
        const isVar2 = vars2.has(arg2);

        // If both are constants, they must match
        if (!isVar1 && !isVar2 && arg1 !== arg2) {
            return false; // Conflicting constants - no overlap
        }
    }

    // If we get here, they can overlap
    return true;
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
