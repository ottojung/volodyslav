/**
 * Tests for dependency_graph/unify module.
 */

const { unify, substitute } = require("../src/generators/dependency_graph/unify");
const { compileSchema } = require("../src/generators/dependency_graph/schema");

describe("dependency_graph/unify", () => {
    describe("unify()", () => {
        test("unifies simple parameterized pattern", () => {
            const schema = {
                output: "event_context(e)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("event_context(id123)", compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({ e: "id123" });
        });

        test("unifies with multiple variables", () => {
            const schema = {
                output: "enhanced_event(e,p)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("enhanced_event(id123,photo5)", compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({ e: "id123", p: "photo5" });
        });

        test("unifies with all arguments as variables", () => {
            const schema = {
                output: "result(a,x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("result(val_a,val_x)", compiled);

            expect(result).not.toBeNull();
            // Both a and x are variables now
            expect(result.bindings).toEqual({ a: "val_a", x: "val_x" });
        });

        test("fails to unify with different head", () => {
            const schema = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("bar(val)", compiled);

            expect(result).toBeNull();
        });

        test("fails to unify with different arity", () => {
            const schema = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("foo(a,b)", compiled);

            expect(result).toBeNull();
        });

        test("unifies when repeated variable has consistent binding", () => {
            // result(a,x) with a=val_a and x=val_a should unify to result(val_a,val_a)
            const schema = {
                output: "result(a,x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("result(same,same)", compiled);

            expect(result).not.toBeNull();
            // a and x should both bind to "same"
            expect(result.bindings).toEqual({ a: "same", x: "same" });
        });

        test("fails to unify with inconsistent variable binding", () => {
            const schema = {
                output: "pair(x,x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("pair(a,b)", compiled);

            expect(result).toBeNull();
        });

        test("unifies with consistent repeated variable", () => {
            const schema = {
                output: "pair(x,x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("pair(a,a)", compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({ x: "a" });
        });

        test("unifies constant pattern", () => {
            const schema = {
                output: "all_events",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            const result = unify("all_events", compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({});
        });
    });

    describe("substitute()", () => {
        test("substitutes single variable", () => {
            const result = substitute("photo(p)", { p: "photo5" }, new Set(["p"]));
            expect(result).toBe("photo(photo5)");
        });

        test("substitutes multiple variables", () => {
            const result = substitute(
                "relation(a,b)",
                { a: "id1", b: "id2" },
                new Set(["a", "b"])
            );
            expect(result).toBe("relation(id1,id2)");
        });

        test("passes through constants", () => {
            const result = substitute("photo(x)", { x: "val" }, new Set(["x"]));
            expect(result).toBe("photo(val)");
        });

        test("substitutes constant pattern unchanged", () => {
            const result = substitute("all_events", {}, new Set());
            expect(result).toBe("all_events");
        });

        test("handles mixed constants and variables", () => {
            const result = substitute("mix(a,x,b)", { x: "val" }, new Set(["x"]));
            expect(result).toBe("mix(a,val,b)");
        });

        test("throws if variable not in bindings", () => {
            expect(() => substitute("photo(p)", {}, new Set(["p"]))).toThrow();
        });
    });
});
