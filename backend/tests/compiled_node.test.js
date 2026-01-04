/**
 * Tests for compiled_node module.
 */

const { compileNodeDef, extractVariables } = require("../src/generators/dependency_graph/compiled_node");
const { parseExpr } = require("../src/generators/dependency_graph/expr");

describe("compiled_node", () => {
    describe("extractVariables()", () => {
        test("extracts variables from call expression", () => {
            const expr = parseExpr("foo(x, y, z)");
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set(["x", "y", "z"]));
        });

        test("returns empty set for atom expression", () => {
            const expr = parseExpr("all_events");
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set());
        });

        test("extracts all identifiers as variables", () => {
            const expr = parseExpr("mix(x, y)");
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
            expect(compiled.outputArgKinds).toEqual(["identifier"]);
            expect(compiled.varsUsedInInputs).toEqual(new Set());
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
    });

    describe("validateNoOverlap()", () => {
        const { validateNoOverlap } = require("../src/generators/dependency_graph/compiled_node");

        test("accepts non-overlapping patterns with different heads", () => {
            const nodes = [
                compileNodeDef({
                    output: 'foo(x)',
                    inputs: [],
                    computor: () => ({}),
                }),
                compileNodeDef({
                    output: 'bar(y)',
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
