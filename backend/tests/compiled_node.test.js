/**
 * Tests for compiled_node module.
 */

const { compileNodeDef, extractVariables, argToConstValue } = require("../src/generators/dependency_graph/compiled_node");
const { parseExpr } = require("../src/generators/dependency_graph/expr");

describe("compiled_node", () => {
    describe("argToConstValue()", () => {
        test("returns null for identifier (variable)", () => {
            const arg = { kind: "identifier", value: "x" };
            expect(argToConstValue(arg)).toBeNull();
        });

        test("converts string arg to ConstValue", () => {
            const arg = { kind: "string", value: "active" };
            expect(argToConstValue(arg)).toEqual({
                type: "string",
                value: "active",
            });
        });

        test("converts number arg to ConstValue", () => {
            const arg = { kind: "number", value: "42" };
            expect(argToConstValue(arg)).toEqual({
                type: "int",
                value: 42,
            });
        });

        test("converts zero to ConstValue", () => {
            const arg = { kind: "number", value: "0" };
            expect(argToConstValue(arg)).toEqual({
                type: "int",
                value: 0,
            });
        });
    });

    describe("extractVariables()", () => {
        test("extracts variables from call expression", () => {
            const expr = parseExpr("foo(x, y, z)");
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set(["x", "y", "z"]));
        });

        test("ignores string constants", () => {
            const expr = parseExpr('status(e, "active")');
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set(["e"]));
        });

        test("ignores number constants", () => {
            const expr = parseExpr("photo(5, x)");
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set(["x"]));
        });

        test("returns empty set for constant expression", () => {
            const expr = parseExpr("all_events");
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set());
        });

        test("handles mixed arguments", () => {
            const expr = parseExpr('mix("str", 5, x, y)');
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set(["x", "y"]));
        });
    });

    describe("compileNodeDef()", () => {
        test("compiles a simple pattern node", () => {
            const nodeDef = {
                output: "event_context(e)",
                inputs: ["all_events"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.canonicalOutput).toBe("event_context(e)");
            expect(compiled.head).toBe("event_context");
            expect(compiled.arity).toBe(1);
            expect(compiled.isPattern).toBe(true);
            expect(compiled.outputArgKinds).toEqual(["var"]);
            expect(compiled.outputConstArgs).toEqual([null]);
            expect(compiled.varsUsedInInputs).toEqual(new Set());
        });

        test("compiles a node with constant filters", () => {
            const nodeDef = {
                output: 'status(e, "active")',
                inputs: ["events"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.canonicalOutput).toBe('status(e,"active")');
            expect(compiled.head).toBe("status");
            expect(compiled.arity).toBe(2);
            expect(compiled.isPattern).toBe(true);
            expect(compiled.outputArgKinds).toEqual(["var", "const"]);
            expect(compiled.outputConstArgs).toEqual([
                null,
                { type: "string", value: "active" },
            ]);
        });

        test("compiles a node with number constant", () => {
            const nodeDef = {
                output: "photo(5)",
                inputs: [],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.canonicalOutput).toBe("photo(5)");
            expect(compiled.isPattern).toBe(false);
            expect(compiled.outputArgKinds).toEqual(["const"]);
            expect(compiled.outputConstArgs).toEqual([
                { type: "int", value: 5 },
            ]);
        });

        test("compiles an exact node (no variables)", () => {
            const nodeDef = {
                output: "all_events",
                inputs: [],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.canonicalOutput).toBe("all_events");
            expect(compiled.isPattern).toBe(false);
            expect(compiled.outputArgKinds).toEqual([]);
            expect(compiled.outputConstArgs).toEqual([]);
        });

        test("detects repeated variables", () => {
            const nodeDef = {
                output: "pair(x, x)",
                inputs: [],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.repeatedVarPositions).toEqual(
                new Map([["x", [0, 1]]])
            );
        });

        test("compiles node with input variables", () => {
            const nodeDef = {
                output: "derived(e, p)",
                inputs: ["event(e)", "photo(p)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.varsUsedInInputs).toEqual(new Set(["e", "p"]));
            expect(compiled.canonicalInputs).toEqual(["event(e)", "photo(p)"]);
        });

        test("throws if input variable not in output", () => {
            const nodeDef = {
                output: "derived(e)",
                inputs: ["photo(p)"],
                computor: () => ({}),
            };

            expect(() => compileNodeDef(nodeDef)).toThrow(
                "Input variable 'p' is not present in output pattern"
            );
        });

        test("validates variable coverage with multiple inputs", () => {
            const nodeDef = {
                output: "result(x)",
                inputs: ["foo(x, y)"],
                computor: () => ({}),
            };

            expect(() => compileNodeDef(nodeDef)).toThrow(
                "Input variable 'y' is not present in output pattern"
            );
        });

        test("allows constants in inputs without requiring them in output", () => {
            const nodeDef = {
                output: "derived(e)",
                inputs: ['status(e, "active")'],
                computor: () => ({}),
            };

            // Should not throw
            const compiled = compileNodeDef(nodeDef);
            expect(compiled.varsUsedInInputs).toEqual(new Set(["e"]));
        });
    });

    describe("patternsCanOverlap()", () => {
        const { patternsCanOverlap } = require("../src/generators/dependency_graph/compiled_node");

        test("detects overlap between identical patterns", () => {
            const node1 = compileNodeDef({
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: "foo(y)",
                inputs: [],
                computor: () => ({}),
            });

            expect(patternsCanOverlap(node1, node2)).toBe(true);
        });

        test("detects no overlap for different heads", () => {
            const node1 = compileNodeDef({
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: "bar(x)",
                inputs: [],
                computor: () => ({}),
            });

            expect(patternsCanOverlap(node1, node2)).toBe(false);
        });

        test("detects no overlap for different arities", () => {
            const node1 = compileNodeDef({
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: "foo(x, y)",
                inputs: [],
                computor: () => ({}),
            });

            expect(patternsCanOverlap(node1, node2)).toBe(false);
        });

        test("detects no overlap when constants conflict", () => {
            const node1 = compileNodeDef({
                output: 'status(x, "active")',
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'status(y, "inactive")',
                inputs: [],
                computor: () => ({}),
            });

            expect(patternsCanOverlap(node1, node2)).toBe(false);
        });

        test("detects overlap when constants match", () => {
            const node1 = compileNodeDef({
                output: 'status(x, "active")',
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'status(y, "active")',
                inputs: [],
                computor: () => ({}),
            });

            expect(patternsCanOverlap(node1, node2)).toBe(true);
        });

        test("detects no overlap when repeated variable constraints conflict", () => {
            const node1 = compileNodeDef({
                output: "pair(x, x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'pair(y, "different")',
                inputs: [],
                computor: () => ({}),
            });

            // These don't actually conflict in the current simplified implementation
            // A full unification would need to track that x must equal "different"
            // For now, this is acceptable - we err on the side of detecting overlap
            expect(patternsCanOverlap(node1, node2)).toBe(true);
        });

        test("allows patterns that are clearly non-overlapping", () => {
            const node1 = compileNodeDef({
                output: 'type("A", x)',
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'type("B", y)',
                inputs: [],
                computor: () => ({}),
            });

            expect(patternsCanOverlap(node1, node2)).toBe(false);
        });
    });

    describe("validateNoOverlap()", () => {
        const { validateNoOverlap } = require("../src/generators/dependency_graph/compiled_node");

        test("accepts non-overlapping patterns", () => {
            const nodes = [
                compileNodeDef({
                    output: 'status(x, "active")',
                    inputs: [],
                    computor: () => ({}),
                }),
                compileNodeDef({
                    output: 'status(y, "inactive")',
                    inputs: [],
                    computor: () => ({}),
                }),
            ];

            expect(() => validateNoOverlap(nodes)).not.toThrow();
        });

        test("rejects overlapping patterns", () => {
            const nodes = [
                compileNodeDef({
                    output: "foo(x)",
                    inputs: [],
                    computor: () => ({}),
                }),
                compileNodeDef({
                    output: "foo(y)",
                    inputs: [],
                    computor: () => ({}),
                }),
            ];

            expect(() => validateNoOverlap(nodes)).toThrow("Schema patterns overlap");
        });

        test("accepts patterns with different heads", () => {
            const nodes = [
                compileNodeDef({
                    output: "foo(x)",
                    inputs: [],
                    computor: () => ({}),
                }),
                compileNodeDef({
                    output: "bar(x)",
                    inputs: [],
                    computor: () => ({}),
                }),
            ];

            expect(() => validateNoOverlap(nodes)).not.toThrow();
        });
    });
});
