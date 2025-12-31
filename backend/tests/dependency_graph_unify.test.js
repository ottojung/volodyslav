/**
 * Tests for dependency_graph/unify module.
 */

const { matchConcrete, substitute, validateConcreteKey } = require("../src/generators/dependency_graph/unify");
const { compileNodeDef } = require("../src/generators/dependency_graph/compiled_node");
const { extractVariables } = require("../src/generators/dependency_graph/compiled_node");
const { parseExpr } = require("../src/generators/dependency_graph/expr");

describe("dependency_graph/unify", () => {
    describe("validateConcreteKey()", () => {
        test("accepts concrete keys with only constants", () => {
            expect(() => validateConcreteKey('status("active")')).not.toThrow();
            expect(() => validateConcreteKey("photo(5)")).not.toThrow();
            expect(() => validateConcreteKey('foo("a", 42)')).not.toThrow();
        });

        test("rejects keys with variables (identifiers)", () => {
            expect(() => validateConcreteKey("status(x)")).toThrow();
            expect(() => validateConcreteKey('foo("str", x)')).toThrow();
        });

        test("accepts constant expressions", () => {
            expect(() => validateConcreteKey("all_events")).not.toThrow();
        });
    });

    describe("matchConcrete()", () => {
        test("matches simple parameterized pattern", () => {
            const nodeDef = {
                output: "event_context(e)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('event_context("id123")', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                e: { kind: "string", value: "id123" },
            });
        });

        test("matches with multiple variables", () => {
            const nodeDef = {
                output: "enhanced_event(e, p)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('enhanced_event("id123", "photo5")', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                e: { kind: "string", value: "id123" },
                p: { kind: "string", value: "photo5" },
            });
        });

        test("matches with number constants", () => {
            const nodeDef = {
                output: "photo(id)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete("photo(42)", compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                id: { kind: "nat", value: 42 },
            });
        });

        test("matches with constants in pattern", () => {
            const nodeDef = {
                output: 'result("a", x)',
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('result("a", "val1")', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                x: { kind: "string", value: "val1" },
            });
        });

        test("fails to match with different head", () => {
            const nodeDef = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('bar("val")', compiled);

            expect(result).toBeNull();
        });

        test("fails to match with different arity", () => {
            const nodeDef = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('foo("a", "b")', compiled);

            expect(result).toBeNull();
        });

        test("fails to match with mismatched constant", () => {
            const nodeDef = {
                output: 'result("a", x)',
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('result("b", "val")', compiled);

            expect(result).toBeNull();
        });

        test("fails to match with inconsistent variable binding", () => {
            const nodeDef = {
                output: "pair(x, x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('pair("a", "b")', compiled);

            expect(result).toBeNull();
        });

        test("matches with consistent repeated variable", () => {
            const nodeDef = {
                output: "pair(x, x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('pair("a", "a")', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                x: { kind: "string", value: "a" },
            });
        });

        test("matches constant pattern", () => {
            const nodeDef = {
                output: "all_events",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete("all_events", compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({});
        });

        test("throws if concrete key contains variables", () => {
            const nodeDef = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            
            expect(() => matchConcrete("foo(y)", compiled)).toThrow();
        });
    });

    describe("substitute()", () => {
        test("substitutes single variable with string", () => {
            const bindings = { p: { kind: "string", value: "photo5" } };
            const variables = new Set(["p"]);
            const result = substitute("photo(p)", bindings, variables);
            expect(result).toBe('photo("photo5")');
        });

        test("substitutes single variable with number", () => {
            const bindings = { id: { kind: "nat", value: 42 } };
            const variables = new Set(["id"]);
            const result = substitute("photo(id)", bindings, variables);
            expect(result).toBe("photo(42)");
        });

        test("substitutes multiple variables", () => {
            const bindings = {
                a: { kind: "string", value: "id1" },
                b: { kind: "string", value: "id2" },
            };
            const variables = new Set(["a", "b"]);
            const result = substitute("relation(a, b)", bindings, variables);
            expect(result).toBe('relation("id1","id2")');
        });

        test("passes through constants", () => {
            const bindings = { x: { kind: "string", value: "val" } };
            const variables = new Set(["x"]);
            const result = substitute('photo("const", x)', bindings, variables);
            expect(result).toBe('photo("const","val")');
        });

        test("substitutes constant pattern unchanged", () => {
            const result = substitute("all_events", {}, new Set());
            expect(result).toBe("all_events");
        });

        test("handles mixed constants and variables", () => {
            const bindings = { x: { kind: "string", value: "val" } };
            const variables = new Set(["x"]);
            const result = substitute('mix("a", x, 5)', bindings, variables);
            expect(result).toBe('mix("a","val",5)');
        });

        test("throws if variable not in bindings", () => {
            expect(() =>
                substitute("photo(p)", {}, new Set(["p"]))
            ).toThrow();
        });
    });
});
