/**
 * Tests for schema compilation and unification.
 */

const {
    compileSchema,
    unify,
    instantiate,
    makeSchemaIndex,
} = require("../src/generators/dependency_graph/schema");

describe("schema compilation and unification", () => {
    describe("compileSchema()", () => {
        test("compiles constant schema", () => {
            const schema = {
                output: "all_events",
                inputs: [],
                variables: [],
                computor: () => ({}),
            };

            const compiled = compileSchema(schema);
            expect(compiled.head).toBe("all_events");
            expect(compiled.arity).toBe(0);
            expect(compiled.outputArgs).toEqual([]);
            expect(compiled.variableSet.size).toBe(0);
        });

        test("compiles parameterized schema with one variable", () => {
            const schema = {
                output: "event_context(e)",
                inputs: ["meta_events"],
                variables: ["e"],
                computor: () => ({}),
            };

            const compiled = compileSchema(schema);
            expect(compiled.head).toBe("event_context");
            expect(compiled.arity).toBe(1);
            expect(compiled.outputArgs).toEqual(["e"]);
            expect(compiled.variableSet.has("e")).toBe(true);
        });

        test("compiles schema with multiple variables", () => {
            const schema = {
                output: "enhanced_event(e, p)",
                inputs: ["event_context(e)", "photo(p)"],
                variables: ["e", "p"],
                computor: () => ({}),
            };

            const compiled = compileSchema(schema);
            expect(compiled.head).toBe("enhanced_event");
            expect(compiled.arity).toBe(2);
            expect(compiled.outputArgs).toEqual(["e", "p"]);
            expect(compiled.variableSet.has("e")).toBe(true);
            expect(compiled.variableSet.has("p")).toBe(true);
        });
    });

    describe("unify()", () => {
        test("unifies constant with constant", () => {
            const schema = {
                output: "all_events",
                inputs: [],
                variables: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);

            const result = unify("all_events", compiled);
            expect(result.success).toBe(true);
            expect(result.bindings).toEqual({});
        });

        test("fails to unify different constants", () => {
            const schema = {
                output: "all_events",
                inputs: [],
                variables: [],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);

            const result = unify("meta_events", compiled);
            expect(result.success).toBe(false);
        });

        test("unifies call with one variable", () => {
            const schema = {
                output: "event_context(e)",
                inputs: [],
                variables: ["e"],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);

            const result = unify("event_context(id123)", compiled);
            expect(result.success).toBe(true);
            expect(result.bindings).toEqual({ e: "id123" });
        });

        test("unifies call with multiple variables", () => {
            const schema = {
                output: "enhanced_event(e,p)",
                inputs: [],
                variables: ["e", "p"],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);

            const result = unify("enhanced_event(id123,photo5)", compiled);
            expect(result.success).toBe(true);
            expect(result.bindings).toEqual({ e: "id123", p: "photo5" });
        });

        test("enforces consistent bindings for repeated variables", () => {
            const schema = {
                output: "pair(x,x)",
                inputs: [],
                variables: ["x"],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);

            const result1 = unify("pair(a,a)", compiled);
            expect(result1.success).toBe(true);
            expect(result1.bindings).toEqual({ x: "a" });

            const result2 = unify("pair(a,b)", compiled);
            expect(result2.success).toBe(false);
            expect(result2.error).toContain("Inconsistent binding");
        });

        test("matches constants in schema pattern", () => {
            const schema = {
                output: "status(e,active)",
                inputs: [],
                variables: ["e"],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);

            const result1 = unify("status(id123,active)", compiled);
            expect(result1.success).toBe(true);
            expect(result1.bindings).toEqual({ e: "id123" });

            const result2 = unify("status(id123,inactive)", compiled);
            expect(result2.success).toBe(false);
            expect(result2.error).toContain("Constant mismatch");
        });

        test("fails on arity mismatch", () => {
            const schema = {
                output: "node(x)",
                inputs: [],
                variables: ["x"],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);

            const result = unify("node(a,b)", compiled);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Arity mismatch");
        });
    });

    describe("instantiate()", () => {
        test("instantiates constant expression", () => {
            const result = instantiate("all_events", {}, new Set());
            expect(result).toBe("all_events");
        });

        test("instantiates call with one variable", () => {
            const result = instantiate(
                "event_context(e)",
                { e: "id123" },
                new Set(["e"])
            );
            expect(result).toBe("event_context(id123)");
        });

        test("instantiates call with multiple variables", () => {
            const result = instantiate(
                "enhanced_event(e,p)",
                { e: "id123", p: "photo5" },
                new Set(["e", "p"])
            );
            expect(result).toBe("enhanced_event(id123,photo5)");
        });

        test("instantiates call with mixed variables and constants", () => {
            const result = instantiate(
                "status(e,active)",
                { e: "id123" },
                new Set(["e"])
            );
            expect(result).toBe("status(id123,active)");
        });

        test("throws if variable not bound", () => {
            expect(() =>
                instantiate("event_context(e)", {}, new Set(["e"]))
            ).toThrow("Variable e not bound");
        });
    });

    describe("SchemaIndex", () => {
        test("finds matching constant schema", () => {
            const schemas = [
                {
                    output: "all_events",
                    inputs: [],
                    variables: [],
                    computor: () => ({ type: "all" }),
                },
                {
                    output: "meta_events",
                    inputs: [],
                    variables: [],
                    computor: () => ({ type: "meta" }),
                },
            ];

            const index = makeSchemaIndex(schemas);

            const match1 = index.findMatch("all_events");
            expect(match1).toBeDefined();
            expect(match1?.compiled.schema.output).toBe("all_events");
            expect(match1?.bindings).toEqual({});

            const match2 = index.findMatch("meta_events");
            expect(match2).toBeDefined();
            expect(match2?.compiled.schema.output).toBe("meta_events");
        });

        test("finds matching parameterized schema", () => {
            const schemas = [
                {
                    output: "event_context(e)",
                    inputs: ["meta_events"],
                    variables: ["e"],
                    computor: () => ({}),
                },
            ];

            const index = makeSchemaIndex(schemas);

            const match = index.findMatch("event_context(id123)");
            expect(match).toBeDefined();
            expect(match?.compiled.schema.output).toBe("event_context(e)");
            expect(match?.bindings).toEqual({ e: "id123" });
        });

        test("returns undefined for no match", () => {
            const schemas = [
                {
                    output: "all_events",
                    inputs: [],
                    variables: [],
                    computor: () => ({}),
                },
            ];

            const index = makeSchemaIndex(schemas);

            const match = index.findMatch("unknown_node");
            expect(match).toBeUndefined();
        });

        test("disambiguates schemas by arity", () => {
            const schemas = [
                {
                    output: "node(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({ arity: 1 }),
                },
                {
                    output: "node(x,y)",
                    inputs: [],
                    variables: ["x", "y"],
                    computor: () => ({ arity: 2 }),
                },
            ];

            const index = makeSchemaIndex(schemas);

            const match1 = index.findMatch("node(a)");
            expect(match1?.compiled.arity).toBe(1);
            expect(match1?.bindings).toEqual({ x: "a" });

            const match2 = index.findMatch("node(a,b)");
            expect(match2?.compiled.arity).toBe(2);
            expect(match2?.bindings).toEqual({ x: "a", y: "b" });
        });
    });
});
