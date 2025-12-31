/**
 * Schema compilation, indexing, and unification for parameterized dependency graphs.
 */

const { parseExpr, canonicalize, isCallExpr } = require("./expression");

/** @typedef {import('./types').Schema} Schema */
/** @typedef {import('./expression').Expression} Expression */

/**
 * @typedef {Object} CompiledSchema
 * @property {Schema} schema - The original schema
 * @property {string} canonicalOutput - Canonical form of the output expression
 * @property {Expression} outputExpr - Parsed output expression
 * @property {string} head - Function name (for calls) or constant name
 * @property {number} arity - Number of arguments (0 for constants)
 * @property {Array<string>} outputArgs - Arguments in output expression
 * @property {Set<string>} variableSet - Set of all variables for quick lookup
 */

/**
 * @typedef {Object} UnificationResult
 * @property {boolean} success - Whether unification succeeded
 * @property {Record<string, string>} bindings - Variable to constant mappings
 * @property {string} [error] - Error message if unification failed
 */

/**
 * Compile a schema for efficient matching and unification.
 *
 * @param {Schema} schema
 * @returns {CompiledSchema}
 */
function compileSchema(schema) {
    const canonicalOutput = canonicalize(schema.output);
    const outputExpr = parseExpr(schema.output);

    const head = outputExpr.name;
    const arity = isCallExpr(outputExpr) ? outputExpr.args.length : 0;
    const outputArgs = isCallExpr(outputExpr) ? outputExpr.args : [];
    const variableSet = new Set(schema.variables);

    return {
        schema,
        canonicalOutput,
        outputExpr,
        head,
        arity,
        outputArgs,
        variableSet,
    };
}

/**
 * Attempt to unify a concrete node name with a compiled schema.
 * Returns bindings if successful, or an error if not.
 *
 * @param {string} concreteNode - Concrete node name (canonical form)
 * @param {CompiledSchema} compiled - Compiled schema
 * @returns {UnificationResult}
 */
function unify(concreteNode, compiled) {
    const concreteExpr = parseExpr(concreteNode);

    // Check if heads match
    if (concreteExpr.name !== compiled.head) {
        return {
            success: false,
            bindings: {},
            error: `Head mismatch: ${concreteExpr.name} vs ${compiled.head}`,
        };
    }

    // Check if arities match
    const concreteArity = isCallExpr(concreteExpr)
        ? concreteExpr.args.length
        : 0;
    if (concreteArity !== compiled.arity) {
        return {
            success: false,
            bindings: {},
            error: `Arity mismatch: ${concreteArity} vs ${compiled.arity}`,
        };
    }

    // For constants, we have a match
    if (compiled.arity === 0) {
        return {
            success: true,
            bindings: {},
        };
    }

    // For calls, unify arguments
    const concreteArgs = isCallExpr(concreteExpr) ? concreteExpr.args : [];
    /** @type {Record<string, string>} */
    const bindings = {};

    for (let i = 0; i < compiled.arity; i++) {
        const schemaArg = compiled.outputArgs[i];
        const concreteArg = concreteArgs[i];
        
        // Check for undefined arguments
        if (schemaArg === undefined || concreteArg === undefined) {
            return {
                success: false,
                bindings: {},
                error: `Argument mismatch at position ${i}`,
            };
        }

        if (compiled.variableSet.has(schemaArg)) {
            // schemaArg is a variable - bind it
            if (schemaArg in bindings) {
                // Variable already bound - check consistency
                if (bindings[schemaArg] !== concreteArg) {
                    return {
                        success: false,
                        bindings: {},
                        error: `Inconsistent binding for variable ${schemaArg}: ${bindings[schemaArg]} vs ${concreteArg}`,
                    };
                }
            } else {
                // Bind variable
                bindings[schemaArg] = concreteArg;
            }
        } else {
            // schemaArg is a constant - must match exactly
            if (schemaArg !== concreteArg) {
                return {
                    success: false,
                    bindings: {},
                    error: `Constant mismatch at position ${i}: ${schemaArg} vs ${concreteArg}`,
                };
            }
        }
    }

    return {
        success: true,
        bindings,
    };
}

/**
 * Instantiate an expression by substituting bindings for variables.
 *
 * @param {string} exprStr - Expression string (may contain variables)
 * @param {Record<string, string>} bindings - Variable to constant mappings
 * @param {Set<string>} variables - Set of known variable names
 * @returns {string} Concrete expression (canonical form)
 */
function instantiate(exprStr, bindings, variables) {
    const expr = parseExpr(exprStr);

    if (!isCallExpr(expr)) {
        // Constant expression - return as-is
        return expr.name;
    }

    // Call expression - substitute variables in arguments
    const instantiatedArgs = expr.args.map((arg) => {
        if (variables.has(arg)) {
            // It's a variable - substitute
            if (!(arg in bindings)) {
                throw new Error(
                    `Variable ${arg} not bound during instantiation of ${exprStr}`
                );
            }
            return bindings[arg];
        } else {
            // It's a constant - keep as-is
            return arg;
        }
    });

    // Return canonical form
    return `${expr.name}(${instantiatedArgs.join(",")})`;
}

/**
 * Schema index for efficient lookup by (head, arity).
 */
class SchemaIndex {
    /**
     * Map from "head:arity" to array of compiled schemas.
     * @private
     */
    index = new Map();

    /**
     * All compiled schemas.
     * @private
     * @type {Array<CompiledSchema>}
     */
    schemas;

    /**
     * @constructor
     * @param {Array<Schema>} schemas - Array of schema definitions
     */
    constructor(schemas) {
        this.index = new Map();
        this.schemas = [];

        for (const schema of schemas) {
            const compiled = compileSchema(schema);
            this.schemas.push(compiled);

            const key = `${compiled.head}:${compiled.arity}`;
            if (!this.index.has(key)) {
                this.index.set(key, []);
            }
            const arr = this.index.get(key);
            if (arr === undefined) {
                throw new Error(`Unexpected undefined for key ${key}`);
            }
            arr.push(compiled);
        }
    }

    /**
     * Find a schema that matches the given concrete node name.
     * Returns the compiled schema and bindings, or undefined if no match.
     *
     * @param {string} concreteNode - Concrete node name (canonical form)
     * @returns {{compiled: CompiledSchema, bindings: Record<string, string>} | undefined}
     */
    findMatch(concreteNode) {
        const expr = parseExpr(concreteNode);
        const head = expr.name;
        const arity = isCallExpr(expr) ? expr.args.length : 0;

        const key = `${head}:${arity}`;
        const candidates = this.index.get(key);

        if (!candidates) {
            return undefined;
        }

        // Try to unify with each candidate
        for (const compiled of candidates) {
            const result = unify(concreteNode, compiled);
            if (result.success) {
                return {
                    compiled,
                    bindings: result.bindings,
                };
            }
        }

        return undefined;
    }

    /**
     * Get all compiled schemas.
     * @returns {Array<CompiledSchema>}
     */
    getAllSchemas() {
        return this.schemas;
    }
}

/**
 * Factory function to create a SchemaIndex.
 * @param {Array<Schema>} schemas
 * @returns {SchemaIndex}
 */
function makeSchemaIndex(schemas) {
    return new SchemaIndex(schemas);
}

module.exports = {
    compileSchema,
    unify,
    instantiate,
    makeSchemaIndex,
};
