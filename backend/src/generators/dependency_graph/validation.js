/**
 * Schema validation for dependency graphs.
 */

const { parseExpr, isCallExpr } = require("./expression");
const { compileSchema, unify } = require("./schema");

/** @typedef {import('./types').Schema} Schema */
/** @typedef {import('./schema').CompiledSchema} CompiledSchema */

/**
 * Error thrown when schema definition is invalid.
 */
class SchemaValidationError extends Error {
    /**
     * @param {string} message
     * @param {Schema} schema
     */
    constructor(message, schema) {
        super(message);
        this.name = "SchemaValidationError";
        this.schema = schema;
    }
}

/**
 * Validate that all variables in input expressions are covered by output variables.
 *
 * @param {Schema} schema
 * @throws {SchemaValidationError} If validation fails
 */
function validateInputVariablesCovered(schema) {
    const outputVars = new Set(schema.variables);
    
    // Also need to check which variables actually appear in the output expression
    const outputExpr = parseExpr(schema.output);
    const varsInOutput = new Set();
    
    if (isCallExpr(outputExpr)) {
        for (const arg of outputExpr.args) {
            if (schema.variables.includes(arg)) {
                varsInOutput.add(arg);
            }
        }
    }

    for (const input of schema.inputs) {
        const inputExpr = parseExpr(input);

        if (!isCallExpr(inputExpr)) {
            // Constant input - no variables to check
            continue;
        }

        // Check each argument in the call
        for (const arg of inputExpr.args) {
            // If arg is in schema.variables, it must also appear in the output expression
            if (schema.variables.includes(arg) && !varsInOutput.has(arg)) {
                throw new SchemaValidationError(
                    `Input expression "${input}" uses variable "${arg}" which does not appear in output expression "${schema.output}"`,
                    schema
                );
            }
        }
    }
}

/**
 * Check if two schemas could both match the same concrete node.
 * Returns true if they overlap (ambiguous).
 *
 * @param {CompiledSchema} schema1
 * @param {CompiledSchema} schema2
 * @returns {boolean}
 */
function schemasOverlap(schema1, schema2) {
    // Different heads or arities => no overlap
    if (schema1.head !== schema2.head) {
        return false;
    }
    if (schema1.arity !== schema2.arity) {
        return false;
    }

    // For constants, same head+arity means they're identical => overlap
    if (schema1.arity === 0) {
        return true;
    }

    // For calls, check if there's a concrete node that could match both
    // Two patterns overlap if at every position, they don't have conflicting constants

    for (let i = 0; i < schema1.arity; i++) {
        const arg1 = schema1.outputArgs[i];
        const arg2 = schema2.outputArgs[i];

        const isVar1 = schema1.variableSet.has(arg1);
        const isVar2 = schema2.variableSet.has(arg2);

        // If both are constants and different => no overlap
        if (!isVar1 && !isVar2 && arg1 !== arg2) {
            return false;
        }

        // Otherwise (at least one is a variable, or both are same constant) => could match
    }

    // If we get here, there's no position that definitively rules out overlap
    return true;
}

/**
 * Validate that no two schemas can match the same concrete node.
 *
 * @param {Array<Schema>} schemas
 * @throws {SchemaValidationError} If validation fails
 */
function validateSchemasMutuallyExclusive(schemas) {
    const compiled = schemas.map(compileSchema);

    for (let i = 0; i < compiled.length; i++) {
        for (let j = i + 1; j < compiled.length; j++) {
            const schema1 = compiled[i];
            const schema2 = compiled[j];

            if (schemasOverlap(schema1, schema2)) {
                throw new SchemaValidationError(
                    `Schemas are not mutually exclusive:\n` +
                        `  Schema 1: ${schema1.canonicalOutput}\n` +
                        `  Schema 2: ${schema2.canonicalOutput}\n` +
                        `Both could match the same concrete node.`,
                    schema1.schema
                );
            }
        }
    }
}

/**
 * Validate all schemas in a dependency graph.
 *
 * @param {Array<Schema>} schemas
 * @throws {SchemaValidationError} If any validation fails
 */
function validateSchemas(schemas) {
    // Validate each schema individually
    for (const schema of schemas) {
        validateInputVariablesCovered(schema);
    }

    // Validate mutual exclusivity
    validateSchemasMutuallyExclusive(schemas);
}

/**
 * Type guard for SchemaValidationError.
 * @param {unknown} error
 * @returns {error is SchemaValidationError}
 */
function isSchemaValidationError(error) {
    return error instanceof SchemaValidationError;
}

module.exports = {
    SchemaValidationError,
    validateInputVariablesCovered,
    validateSchemasMutuallyExclusive,
    validateSchemas,
    isSchemaValidationError,
};
