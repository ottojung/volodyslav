/**
 * Tests for compiled_node module.
 */

const { compileNodeDef, extractVariables } = require("../src/generators/dependency_graph/compiled_node");
const { parseExpr } = require("../src/generators/dependency_graph/expr");
const { isInvalidSchema } = require("../src/generators/dependency_graph/errors");

describe("dependency_graph/compiled_node", () => {
    describe("extractVariables()", () => {
        test("extracts variables from call expression", () => {
            const expr = parseExpr("foo(x,y)");
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set(["x", "y"]));
        });

        test("extracts no variables from constant arguments", () => {
            const expr = parseExpr('foo("a",5)');
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set());
        });

        test("extracts mixed variables and constants", () => {
            const expr = parseExpr('foo(x,"a",5,y)');
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set(["x", "y"]));
        });

        test("extracts no variables from head-only constant", () => {
            const expr = parseExpr("all_events");
            const vars = extractVariables(expr);
            expect(vars).toEqual(new Set());
        });
    });

    describe("compileNodeDef() - Basic Compilation", () => {
        test("compiles exact node (no variables)", () => {
            const nodeDef = {
                output: "all_events",
                inputs: [],
                computor: () => ({ type: "all_events" }),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.head).toBe("all_events");
            expect(compiled.arity).toBe(0);
            expect(compiled.isPattern).toBe(false);
            expect(compiled.canonicalOutput).toBe("all_events");
            expect(compiled.outputArgKinds).toEqual([]);
            expect(compiled.outputConstArgs).toEqual([]);
            expect(compiled.varsUsedInInputs).toEqual(new Set());
            expect(compiled.repeatedVarPositions).toEqual(new Map());
        });

        test("compiles pattern node with single variable", () => {
            const nodeDef = {
                output: "event_context(e)",
                inputs: ["all_events"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.head).toBe("event_context");
            expect(compiled.arity).toBe(1);
            expect(compiled.isPattern).toBe(true);
            expect(compiled.canonicalOutput).toBe("event_context(e)");
            expect(compiled.outputArgKinds).toEqual(["var"]);
            expect(compiled.outputConstArgs).toEqual([null]);
            expect(compiled.varsUsedInInputs).toEqual(new Set());
            expect(compiled.repeatedVarPositions).toEqual(new Map());
        });

        test("compiles pattern node with multiple variables", () => {
            const nodeDef = {
                output: "enhanced_event(e,p)",
                inputs: ["event(e)", "photo(p)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.head).toBe("enhanced_event");
            expect(compiled.arity).toBe(2);
            expect(compiled.isPattern).toBe(true);
            expect(compiled.canonicalOutput).toBe("enhanced_event(e,p)");
            expect(compiled.outputArgKinds).toEqual(["var", "var"]);
            expect(compiled.outputConstArgs).toEqual([null, null]);
            expect(compiled.varsUsedInInputs).toEqual(new Set(["e", "p"]));
            expect(compiled.repeatedVarPositions).toEqual(new Map());
        });
    });

    describe("compileNodeDef() - Constant Arguments", () => {
        test("compiles pattern with string constant", () => {
            const nodeDef = {
                output: 'status(e,"active")',
                inputs: ["event(e)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.head).toBe("status");
            expect(compiled.arity).toBe(2);
            expect(compiled.isPattern).toBe(true);
            expect(compiled.canonicalOutput).toBe('status(e,"active")');
            expect(compiled.outputArgKinds).toEqual(["var", "const"]);
            expect(compiled.outputConstArgs).toEqual([
                null,
                { kind: "string", value: "active" },
            ]);
            expect(compiled.varsUsedInInputs).toEqual(new Set(["e"]));
        });

        test("compiles pattern with natural number constant", () => {
            const nodeDef = {
                output: "photo_status(p,5)",
                inputs: ["photo(p)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.head).toBe("photo_status");
            expect(compiled.arity).toBe(2);
            expect(compiled.isPattern).toBe(true);
            expect(compiled.canonicalOutput).toBe("photo_status(p,5)");
            expect(compiled.outputArgKinds).toEqual(["var", "const"]);
            expect(compiled.outputConstArgs).toEqual([
                null,
                { kind: "nat", value: 5 },
            ]);
        });

        test("compiles exact node with constants only", () => {
            const nodeDef = {
                output: 'config("theme",0)',
                inputs: [],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.head).toBe("config");
            expect(compiled.arity).toBe(2);
            expect(compiled.isPattern).toBe(false);
            expect(compiled.canonicalOutput).toBe('config("theme",0)');
            expect(compiled.outputArgKinds).toEqual(["const", "const"]);
            expect(compiled.outputConstArgs).toEqual([
                { kind: "string", value: "theme" },
                { kind: "nat", value: 0 },
            ]);
            expect(compiled.repeatedVarPositions).toEqual(new Map());
        });

        test("compiles mixed variables and constants", () => {
            const nodeDef = {
                output: 'foo(x,"a",5,y)',
                inputs: ["bar(x,y)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.arity).toBe(4);
            expect(compiled.outputArgKinds).toEqual(["var", "const", "const", "var"]);
            expect(compiled.outputConstArgs).toEqual([
                null,
                { kind: "string", value: "a" },
                { kind: "nat", value: 5 },
                null,
            ]);
        });
    });

    describe("compileNodeDef() - Repeated Variables", () => {
        test("detects repeated variable in same pattern", () => {
            const nodeDef = {
                output: "pair(x,x)",
                inputs: ["value(x)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.repeatedVarPositions).toEqual(
                new Map([["x", [0, 1]]])
            );
        });

        test("detects multiple repeated variables", () => {
            const nodeDef = {
                output: "quad(x,y,x,y)",
                inputs: ["pair(x,y)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.repeatedVarPositions).toEqual(
                new Map([
                    ["x", [0, 2]],
                    ["y", [1, 3]],
                ])
            );
        });

        test("does not include non-repeated variables", () => {
            const nodeDef = {
                output: "triple(x,y,x)",
                inputs: [],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);

            expect(compiled.repeatedVarPositions).toEqual(
                new Map([["x", [0, 2]]])
            );
            expect(compiled.repeatedVarPositions.has("y")).toBe(false);
        });
    });

    describe("compileNodeDef() - Variable Coverage Validation", () => {
        test("accepts valid schema with variable in output and input", () => {
            const nodeDef = {
                output: "event_context(e)",
                inputs: ["event(e)"],
                computor: () => ({}),
            };

            expect(() => compileNodeDef(nodeDef)).not.toThrow();
        });

        test("accepts schema with extra output variables", () => {
            const nodeDef = {
                output: "result(a,b,c)",
                inputs: ["input(a)"],
                computor: () => ({}),
            };

            expect(() => compileNodeDef(nodeDef)).not.toThrow();
        });

        test("accepts constant inputs", () => {
            const nodeDef = {
                output: "derived(x)",
                inputs: ["all_events", "meta_events"],
                computor: () => ({}),
            };

            expect(() => compileNodeDef(nodeDef)).not.toThrow();
        });

        test("throws if input variable not in output", () => {
            const nodeDef = {
                output: "event_context(e)",
                inputs: ["photo(p)"],
                computor: () => ({}),
            };

            let error = null;
            try {
                compileNodeDef(nodeDef);
            } catch (err) {
                error = err;
            }

            expect(error).not.toBeNull();
            expect(isInvalidSchema(error)).toBe(true);
            expect(error.message).toContain("not present in output");
            expect(error.message).toContain("p");
        });

        test("throws if multiple input variables not in output", () => {
            const nodeDef = {
                output: "result(x)",
                inputs: ["foo(y,z)"],
                computor: () => ({}),
            };

            expect(() => compileNodeDef(nodeDef)).toThrow();
        });
    });

    describe("compileNodeDef() - Canonicalization", () => {
        test("canonicalizes output with whitespace", () => {
            const nodeDef = {
                output: "  foo( x , y )  ",
                inputs: [],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);
            expect(compiled.canonicalOutput).toBe("foo(x,y)");
        });

        test("canonicalizes inputs with whitespace", () => {
            const nodeDef = {
                output: "derived(x)",
                inputs: ["  base( x )  ", " other (x)"],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);
            expect(compiled.canonicalInputs).toEqual(["base(x)", "other(x)"]);
        });

        test("preserves string literal content but canonicalizes format", () => {
            const nodeDef = {
                output: 'foo( "hello world" )',
                inputs: [],
                computor: () => ({}),
            };

            const compiled = compileNodeDef(nodeDef);
            expect(compiled.canonicalOutput).toBe('foo("hello world")');
        });
    });
});
