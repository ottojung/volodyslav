/**
 * Tests for dependency_graph/unify module.
 */

const { matchConcrete, substitute, validateConcreteKey } = require("../src/generators/dependency_graph/unify");
const { compileNodeDef } = require("../src/generators/dependency_graph/compiled_node");

describe("dependency_graph/unify", () => {
    describe("validateConcreteKey()", () => {
        test("accepts atom expressions", () => {
            expect(() => validateConcreteKey('all_events')).not.toThrow();
            expect(() => validateConcreteKey("source")).not.toThrow();
        });

        test("rejects keys with variables (identifiers)", () => {
            expect(() => validateConcreteKey("status(x)")).toThrow();
            expect(() => validateConcreteKey('foo(x, y)')).toThrow();
        });
    });

    describe("matchConcrete()", () => {
        test("matches atom pattern", () => {
            const nodeDef = {
                output: "all_events",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('all_events', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({});
        });

        test("fails to match with different head", () => {
            const nodeDef = {
                output: "foo",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('bar', compiled);

            expect(result).toBeNull();
        });

        test("fails to match when pattern has args but concrete doesn't", () => {
            const nodeDef = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('foo', compiled);

            expect(result).toBeNull();
        });

        test("matches concrete atom pattern", () => {
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
        test("returns pattern unchanged since constants are not supported", () => {
            // Since constants are no longer supported in expressions,
            // substitute now just returns the pattern as-is
            const result = substitute("all_events", {}, new Set());
            expect(result).toBe("all_events");
        });

        test("returns pattern with variables unchanged", () => {
            // Even patterns with variables are returned unchanged
            // since we can't instantiate them with constant values
            const result = substitute("photo(p)", {}, new Set(["p"]));
            expect(result).toBe("photo(p)");
        });
    });
});
