/**
 * Unification algorithm for matching concrete nodes against compiled patterns.
 */

const { parseExpr, renderTerm, renderExpr } = require("./expr");

/** @typedef {import('./compiled_node').CompiledNode} CompiledNode */
/** @typedef {import('./expr').ConstValue} ConstValue */
/** @typedef {import('./expr').Term} Term */

/**
 * Checks if two constant values are equal.
 * @param {ConstValue} a
 * @param {ConstValue} b
 * @returns {boolean}
 */
function constValuesEqual(a, b) {
    if (a.kind !== b.kind) {
        return false;
    }
    return a.value === b.value;
}

/**
 * Attempts to unify a concrete node expression with a compiled node pattern.
 * Returns typed bindings if successful, or null if unification fails.
 *
 * @param {string} concreteKey - The concrete node key (should be canonicalized)
 * @param {CompiledNode} compiledNode - The compiled node to match against
 * @returns {{ bindings: Record<string, ConstValue> } | null} Typed bindings if successful, null otherwise
 */
function matchConcrete(concreteKey, compiledNode) {
    const concreteExpr = parseExpr(concreteKey);

    // Reject if concrete key contains variables (unquoted identifiers)
    if (concreteExpr.kind === "call") {
        for (const arg of concreteExpr.args) {
            if (arg.kind === "var") {
                throw new Error(
                    `Concrete request '${concreteKey}' contains variable '${arg.name}'. ` +
                    `Use quoted strings for identifier-like constants.`
                );
            }
        }
    }

    // Must have same head
    if (concreteExpr.name !== compiledNode.head) {
        return null;
    }

    // Must have same arity
    if (concreteExpr.args.length !== compiledNode.arity) {
        return null;
    }

    /** @type {Record<string, ConstValue>} */
    const bindings = {};

    // Try to unify each argument position
    for (let i = 0; i < compiledNode.arity; i++) {
        const concreteArg = concreteExpr.args[i];
        const patternArgKind = compiledNode.outputArgKinds[i];
        const patternConstArg = compiledNode.outputConstArgs[i];
        const patternTerm = compiledNode.outputExpr.args[i];

        if (concreteArg === undefined || patternTerm === undefined) {
            return null; // Arity mismatch
        }

        // Concrete arg must be a constant
        if (concreteArg.kind !== "const" || !concreteArg.value) {
            throw new Error(
                `Internal error: concrete arg at position ${i} is not a constant`
            );
        }

        if (patternArgKind === "var") {
            // Pattern expects a variable - bind it to concrete constant
            const varName = patternTerm.name;

            if (varName in bindings) {
                // Variable already bound - check consistency
                if (!constValuesEqual(bindings[varName], concreteArg.value)) {
                    return null; // Inconsistent binding (repeated var constraint violated)
                }
            } else {
                // New binding
                bindings[varName] = concreteArg.value;
            }
        } else {
            // Pattern expects a constant - must match exactly
            if (patternConstArg === null) {
                throw new Error(
                    `Internal error: pattern arg at position ${i} is marked const but has no value`
                );
            }

            if (!constValuesEqual(patternConstArg, concreteArg.value)) {
                return null; // Constant mismatch
            }
        }
    }

    return { bindings };
}

/**
 * Substitutes variables in an expression pattern with their typed bindings.
 *
 * @param {string} pattern - The pattern (e.g., "photo(p)")
 * @param {Record<string, ConstValue>} bindings - Typed variable bindings
 * @param {Set<string>} variables - Set of variable names
 * @returns {string} The instantiated pattern (canonicalized)
 */
function substitute(pattern, bindings, variables) {
    const expr = parseExpr(pattern);

    if (expr.kind === "const") {
        // Head-only constants don't need substitution
        return expr.name;
    }

    // Substitute variables in arguments
    const substitutedArgs = expr.args.map((arg) => {
        if (arg.kind === "var" && variables.has(arg.name)) {
            const binding = bindings[arg.name];
            if (!binding) {
                throw new Error(
                    `Variable '${arg.name}' not found in bindings when substituting '${pattern}'`
                );
            }
            // Convert binding to term and render
            return renderTerm({
                kind: "const",
                value: binding,
            });
        }
        // Constants and non-variable identifiers pass through
        return renderTerm(arg);
    });

    return `${expr.name}(${substitutedArgs.join(",")})`;
}

/**
 * Checks if two compiled nodes can potentially match the same concrete nodes (overlap).
 * Uses pattern unification with constraint satisfaction.
 *
 * @param {CompiledNode} node1
 * @param {CompiledNode} node2
 * @returns {boolean} True if nodes can overlap
 */
function nodesOverlap(node1, node2) {
    // Must have same head and arity to overlap
    if (node1.head !== node2.head || node1.arity !== node2.arity) {
        return false;
    }

    // Try to find a substitution that makes both patterns identical
    /** @type {Map<string, ConstValue | string>} */
    const constraints = new Map();

    for (let i = 0; i < node1.arity; i++) {
        const arg1 = node1.outputExpr.args[i];
        const arg2 = node2.outputExpr.args[i];
        const kind1 = node1.outputArgKinds[i];
        const kind2 = node2.outputArgKinds[i];

        if (arg1 === undefined || arg2 === undefined) {
            throw new Error(`Unexpected undefined argument at position ${i}`);
        }

        if (kind1 === "const" && kind2 === "const") {
            // Both constants - must be equal
            const const1 = node1.outputConstArgs[i];
            const const2 = node2.outputConstArgs[i];
            if (const1 === null || const2 === null) {
                throw new Error("Const arg has no value");
            }
            if (!constValuesEqual(const1, const2)) {
                return false; // Conflicting constants - no overlap
            }
        } else if (kind1 === "var" && kind2 === "const") {
            // node1 has var, node2 has const - constrain var to const
            const varName = arg1.name;
            const constVal = node2.outputConstArgs[i];
            if (constVal === null) {
                throw new Error("Const arg has no value");
            }

            if (constraints.has(varName)) {
                const existing = constraints.get(varName);
                if (typeof existing === "string") {
                    // Variable was constrained to another variable - can't satisfy both
                    return false;
                }
                if (!constValuesEqual(existing, constVal)) {
                    return false; // Conflicting constraints
                }
            } else {
                constraints.set(varName, constVal);
            }
        } else if (kind1 === "const" && kind2 === "var") {
            // node1 has const, node2 has var - constrain var to const
            const varName = arg2.name;
            const constVal = node1.outputConstArgs[i];
            if (constVal === null) {
                throw new Error("Const arg has no value");
            }

            if (constraints.has(varName)) {
                const existing = constraints.get(varName);
                if (typeof existing === "string") {
                    // Variable was constrained to another variable - can't satisfy both
                    return false;
                }
                if (!constValuesEqual(existing, constVal)) {
                    return false; // Conflicting constraints
                }
            } else {
                constraints.set(varName, constVal);
            }
        } else {
            // Both variables - unify them
            const var1 = arg1.name;
            const var2 = arg2.name;

            // Check if either is already constrained
            const constraint1 = constraints.get(var1);
            const constraint2 = constraints.get(var2);

            if (constraint1 && constraint2) {
                // Both constrained - must be equal
                if (typeof constraint1 === "string" || typeof constraint2 === "string") {
                    // At least one is a var-var constraint - complex case
                    // For simplicity, we consider this as potentially overlapping
                    continue;
                }
                if (!constValuesEqual(constraint1, constraint2)) {
                    return false;
                }
            } else if (constraint1) {
                // var1 constrained, propagate to var2
                constraints.set(var2, constraint1);
            } else if (constraint2) {
                // var2 constrained, propagate to var1
                constraints.set(var1, constraint2);
            } else {
                // Neither constrained - unify them (mark as equivalent)
                constraints.set(var1, var2);
                constraints.set(var2, var1);
            }
        }
    }

    // Check repeated variable constraints for each node
    // For node1: check that repeated vars would bind to same value
    for (const [varName, positions] of node1.repeatedVarPositions.entries()) {
        if (positions.length < 2) continue;

        const constraint = constraints.get(varName);
        if (constraint && typeof constraint !== "string") {
            // Variable is constrained to a constant - all positions must match in node2
            for (const pos of positions) {
                const arg2 = node2.outputExpr.args[pos];
                const kind2 = node2.outputArgKinds[pos];
                if (arg2 === undefined) continue;

                if (kind2 === "const") {
                    const const2 = node2.outputConstArgs[pos];
                    if (const2 === null) continue;
                    if (!constValuesEqual(constraint, const2)) {
                        return false; // Repeated var constraint violated
                    }
                }
            }
        }
    }

    // Similarly for node2
    for (const [varName, positions] of node2.repeatedVarPositions.entries()) {
        if (positions.length < 2) continue;

        const constraint = constraints.get(varName);
        if (constraint && typeof constraint !== "string") {
            // Variable is constrained to a constant - all positions must match in node1
            for (const pos of positions) {
                const arg1 = node1.outputExpr.args[pos];
                const kind1 = node1.outputArgKinds[pos];
                if (arg1 === undefined) continue;

                if (kind1 === "const") {
                    const const1 = node1.outputConstArgs[pos];
                    if (const1 === null) continue;
                    if (!constValuesEqual(constraint, const1)) {
                        return false; // Repeated var constraint violated
                    }
                }
            }
        }
    }

    // If we get here, patterns can overlap
    return true;
}

module.exports = {
    matchConcrete,
    substitute,
    nodesOverlap,
};
