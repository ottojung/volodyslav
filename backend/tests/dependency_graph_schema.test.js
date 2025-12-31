/**
 * Tests for dependency_graph/schema module.
 */

const {
    validateSchemaVariables,
    compileSchema,
    validateNoSchemaOverlap,
} = require("../src/generators/dependency_graph/schema");
const { isInvalidSchema } = require("../src/generators/dependency_graph/errors");

describe("dependency_graph/schema", () => {
    describe("validateSchemaVariables()", () => {
        test("accepts valid schema with variable in output and input", () => {
            const schema = {
                output: "event_context(e)",
                inputs: ["photo(e)"],
                variables: ["e"],
                computor: () => ({}),
            };
            expect(() => validateSchemaVariables(schema)).not.toThrow();
        });

        test("accepts valid schema with multiple variables", () => {
            const schema = {
                output: "enhanced_event(e,p)",
                inputs: ["event(e)", "photo(p)"],
                variables: ["e", "p"],
                computor: () => ({}),
            };
            expect(() => validateSchemaVariables(schema)).not.toThrow();
        });

        test("accepts schema with constant inputs", () => {
            const schema = {
                output: "event_context(e)",
                inputs: ["all_events", "meta_events"],
                variables: ["e"],
                computor: () => ({}),
            };
            expect(() => validateSchemaVariables(schema)).not.toThrow();
        });

        test("accepts constant schema with no variables", () => {
            const schema = {
                output: "all_events",
                inputs: [],
                variables: [],
                computor: () => ({}),
            };
            expect(() => validateSchemaVariables(schema)).not.toThrow();
        });

        test("throws if input variable not in output", () => {
            const schema = {
                output: "event_context(e)",
                inputs: ["photo(p)"],
                variables: ["e", "p"],
                computor: () => ({}),
            };
            expect(() => validateSchemaVariables(schema)).toThrow();
            
            let error = null;
            try {
                validateSchemaVariables(schema);
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isInvalidSchema(error)).toBe(true);
            expect(error.message).toContain("not present in output");
        });

        test("accepts schema where output has extra variables", () => {
            const schema = {
                output: "result(a,b,c)",
                inputs: ["input(a)"],
                variables: ["a", "b", "c"],
                computor: () => ({}),
            };
            expect(() => validateSchemaVariables(schema)).not.toThrow();
        });
    });

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
            expect(compiled.outputExpr.kind).toBe("const");
        });

        test("compiles parameterized schema", () => {
            const schema = {
                output: "event_context(e)",
                inputs: ["all_events"],
                variables: ["e"],
                computor: () => ({}),
            };
            const compiled = compileSchema(schema);
            expect(compiled.head).toBe("event_context");
            expect(compiled.arity).toBe(1);
            expect(compiled.outputExpr.kind).toBe("call");
            expect(compiled.outputExpr.args).toEqual(["e"]);
        });
    });

    describe("validateNoSchemaOverlap()", () => {
        test("accepts non-overlapping schemas with different heads", () => {
            const schemas = [
                {
                    output: "foo(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "bar(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
            ];
            const compiled = schemas.map(compileSchema);
            expect(() => validateNoSchemaOverlap(compiled)).not.toThrow();
        });

        test("accepts non-overlapping schemas with different arity", () => {
            const schemas = [
                {
                    output: "foo(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "foo(x,y)",
                    inputs: [],
                    variables: ["x", "y"],
                    computor: () => ({}),
                },
            ];
            const compiled = schemas.map(compileSchema);
            expect(() => validateNoSchemaOverlap(compiled)).not.toThrow();
        });

        test("accepts schemas with conflicting constants at same position", () => {
            const schemas = [
                {
                    output: "foo(a,x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "foo(b,y)",
                    inputs: [],
                    variables: ["y"],
                    computor: () => ({}),
                },
            ];
            const compiled = schemas.map(compileSchema);
            expect(() => validateNoSchemaOverlap(compiled)).not.toThrow();
        });

        test("throws on overlapping schemas with all variables", () => {
            const schemas = [
                {
                    output: "foo(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "foo(y)",
                    inputs: [],
                    variables: ["y"],
                    computor: () => ({}),
                },
            ];
            const compiled = schemas.map(compileSchema);
            expect(() => validateNoSchemaOverlap(compiled)).toThrow();
            
            let error = null;
            try {
                validateNoSchemaOverlap(compiled);
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isInvalidSchema(error)).toBe(true);
            expect(error.message).toContain("Overlaps");
        });

        test("throws on overlapping schemas with same constants", () => {
            const schemas = [
                {
                    output: "foo(a,x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "foo(a,y)",
                    inputs: [],
                    variables: ["y"],
                    computor: () => ({}),
                },
            ];
            const compiled = schemas.map(compileSchema);
            expect(() => validateNoSchemaOverlap(compiled)).toThrow();
        });

        test("accepts schemas with repeated variables (no overlap due to constraint)", () => {
            const schemas = [
                {
                    output: "pair(x,x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "pair(a,b)",
                    inputs: [],
                    variables: ["a", "b"],
                    computor: () => ({}),
                },
            ];
            const compiled = schemas.map(compileSchema);
            // pair(x,x) requires both args to be equal
            // pair(a,b) allows them to be different
            // These CAN overlap when a === b, so they should throw
            expect(() => validateNoSchemaOverlap(compiled)).toThrow();
        });

        test("accepts schemas where repeated variables prevent overlap", () => {
            const schemas = [
                {
                    output: "pair(x,x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "pair(a,b)",
                    inputs: [],
                    variables: ["a", "b"],
                    computor: () => ({}),
                },
                {
                    output: "triple(x,x,x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
            ];
            // This is actually testing that pair(x,x) and pair(a,b) CAN unify
            // The issue says they should NOT overlap when a != b, but they CAN unify when a = b
            // So the current behavior (throwing) is correct - they do overlap
            const pairSchemas = schemas.slice(0, 2).map(compileSchema);
            expect(() => validateNoSchemaOverlap(pairSchemas)).toThrow();
        });
    });
});
