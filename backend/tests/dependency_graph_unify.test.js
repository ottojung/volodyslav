/**
 * Tests for dependency_graph/unify module.
 */

const { matchConcrete, substitute, nodesOverlap } = require("../src/generators/dependency_graph/unify");
const { compileNodeDef } = require("../src/generators/dependency_graph/compiled_node");

describe("dependency_graph/unify", () => {
    describe("matchConcrete() - Basic Matching", () => {
        test("matches simple parameterized pattern with identifier", () => {
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

        test("matches pattern with natural number", () => {
            const nodeDef = {
                output: "photo(p)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete("photo(5)", compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                p: { kind: "nat", value: 5 },
            });
        });

        test("matches with multiple variables", () => {
            const nodeDef = {
                output: "enhanced_event(e,p)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('enhanced_event("id123",5)', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                e: { kind: "string", value: "id123" },
                p: { kind: "nat", value: 5 },
            });
        });

        test("matches head-only constant", () => {
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

        test("fails with different head", () => {
            const nodeDef = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('bar("val")', compiled);

            expect(result).toBeNull();
        });

        test("fails with different arity", () => {
            const nodeDef = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('foo("a","b")', compiled);

            expect(result).toBeNull();
        });
    });

    describe("matchConcrete() - Constant Filters", () => {
        test("matches pattern with string constant filter", () => {
            const nodeDef = {
                output: 'status(e,"active")',
                inputs: ["event(e)"],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('status("id123","active")', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                e: { kind: "string", value: "id123" },
            });
        });

        test("fails when constant filter doesn't match", () => {
            const nodeDef = {
                output: 'status(e,"active")',
                inputs: ["event(e)"],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('status("id123","inactive")', compiled);

            expect(result).toBeNull();
        });

        test("matches pattern with number constant filter", () => {
            const nodeDef = {
                output: "version(x,2)",
                inputs: ["item(x)"],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('version("item1",2)', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                x: { kind: "string", value: "item1" },
            });
        });

        test("fails when number constant doesn't match", () => {
            const nodeDef = {
                output: "version(x,2)",
                inputs: ["item(x)"],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('version("item1",3)', compiled);

            expect(result).toBeNull();
        });

        test("matches exact node with all constants", () => {
            const nodeDef = {
                output: 'config("theme",0)',
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('config("theme",0)', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({});
        });
    });

    describe("matchConcrete() - Repeated Variable Constraints", () => {
        test("fails with inconsistent repeated variable", () => {
            const nodeDef = {
                output: "pair(x,x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('pair("a","b")', compiled);

            expect(result).toBeNull();
        });

        test("matches with consistent repeated variable", () => {
            const nodeDef = {
                output: "pair(x,x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('pair("a","a")', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                x: { kind: "string", value: "a" },
            });
        });

        test("matches with multiple repeated variables", () => {
            const nodeDef = {
                output: "quad(x,y,x,y)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('quad("a","b","a","b")', compiled);

            expect(result).not.toBeNull();
            expect(result.bindings).toEqual({
                x: { kind: "string", value: "a" },
                y: { kind: "string", value: "b" },
            });
        });

        test("fails with partially inconsistent repeated variables", () => {
            const nodeDef = {
                output: "quad(x,y,x,y)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            const result = matchConcrete('quad("a","b","a","c")', compiled);

            expect(result).toBeNull();
        });
    });

    describe("matchConcrete() - Variable Rejection", () => {
        test("throws when concrete key contains unquoted identifier", () => {
            const nodeDef = {
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            
            expect(() => matchConcrete("foo(bar)", compiled)).toThrow(
                "contains variable"
            );
        });

        test("throws when concrete key has mixed quoted and unquoted", () => {
            const nodeDef = {
                output: "foo(x,y)",
                inputs: [],
                computor: () => ({}),
            };
            const compiled = compileNodeDef(nodeDef);
            
            expect(() => matchConcrete('foo("a",b)', compiled)).toThrow(
                "contains variable"
            );
        });
    });

    describe("substitute() - With Typed Bindings", () => {
        test("substitutes string constant", () => {
            const result = substitute(
                "photo(p)",
                { p: { kind: "string", value: "photo5" } },
                new Set(["p"])
            );
            expect(result).toBe('photo("photo5")');
        });

        test("substitutes natural number", () => {
            const result = substitute(
                "version(v)",
                { v: { kind: "nat", value: 42 } },
                new Set(["v"])
            );
            expect(result).toBe("version(42)");
        });

        test("substitutes multiple variables", () => {
            const result = substitute(
                "relation(a,b)",
                {
                    a: { kind: "string", value: "id1" },
                    b: { kind: "nat", value: 2 },
                },
                new Set(["a", "b"])
            );
            expect(result).toBe('relation("id1",2)');
        });

        test("passes through constant arguments", () => {
            const result = substitute(
                'config("theme",x)',
                { x: { kind: "nat", value: 0 } },
                new Set(["x"])
            );
            expect(result).toBe('config("theme",0)');
        });

        test("substitutes head-only constant unchanged", () => {
            const result = substitute("all_events", {}, new Set());
            expect(result).toBe("all_events");
        });

        test("throws if variable not in bindings", () => {
            expect(() => substitute("photo(p)", {}, new Set(["p"]))).toThrow(
                "not found in bindings"
            );
        });
    });

    describe("nodesOverlap() - Basic Cases", () => {
        test("no overlap with different heads", () => {
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

            expect(nodesOverlap(node1, node2)).toBe(false);
        });

        test("no overlap with different arities", () => {
            const node1 = compileNodeDef({
                output: "foo(x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: "foo(x,y)",
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(false);
        });

        test("overlap with same pattern", () => {
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

            expect(nodesOverlap(node1, node2)).toBe(true);
        });
    });

    describe("nodesOverlap() - Constant Constraints", () => {
        test("no overlap with conflicting constants", () => {
            const node1 = compileNodeDef({
                output: 'status(x,"active")',
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'status(x,"inactive")',
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(false);
        });

        test("overlap with same constant", () => {
            const node1 = compileNodeDef({
                output: 'status(x,"active")',
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'status(y,"active")',
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(true);
        });

        test("overlap when one has constant, other has variable", () => {
            const node1 = compileNodeDef({
                output: 'status(x,"active")',
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: "status(x,y)",
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(true);
        });
    });

    describe("nodesOverlap() - Repeated Variable Constraints", () => {
        test("no overlap when repeated var conflicts with constants", () => {
            const node1 = compileNodeDef({
                output: "pair(x,x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'pair("a","b")',
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(false);
        });

        test("overlap when repeated var matches constants", () => {
            const node1 = compileNodeDef({
                output: "pair(x,x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'pair("a","a")',
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(true);
        });

        test("overlap with both having repeated vars", () => {
            const node1 = compileNodeDef({
                output: "pair(x,x)",
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: "pair(y,y)",
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(true);
        });

        test("no overlap with incompatible repeated variable patterns", () => {
            const node1 = compileNodeDef({
                output: 'triple(x,x,"a")',
                inputs: [],
                computor: () => ({}),
            });
            const node2 = compileNodeDef({
                output: 'triple("a","b","a")',
                inputs: [],
                computor: () => ({}),
            });

            expect(nodesOverlap(node1, node2)).toBe(false);
        });
    });
});
