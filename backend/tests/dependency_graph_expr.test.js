/**
 * Tests for dependency_graph/expr module.
 */

const { parseExpr, canonicalize } = require("../src/generators/dependency_graph/expr");

describe("dependency_graph/expr", () => {
    describe("parseExpr()", () => {
        test("parses an atom", () => {
            const result = parseExpr("all_events");
            expect(result).toEqual({
                kind: "atom",
                name: "all_events",
                args: [],
            });
        });

        test("parses function call with no args (T4)", () => {
            const result = parseExpr("foo()");
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [],
            });
        });

        test("parses a function call with one identifier arg", () => {
            const result = parseExpr("event_context(e)");
            expect(result).toEqual({
                kind: "call",
                name: "event_context",
                args: [{ kind: "identifier", value: "e" }],
            });
        });

        test("parses a function call with multiple identifier args", () => {
            const result = parseExpr("enhanced_event(e,p)");
            expect(result).toEqual({
                kind: "call",
                name: "enhanced_event",
                args: [
                    { kind: "identifier", value: "e" },
                    { kind: "identifier", value: "p" },
                ],
            });
        });

        test("handles whitespace in atom", () => {
            const result = parseExpr("  all_events  ");
            expect(result).toEqual({
                kind: "atom",
                name: "all_events",
                args: [],
            });
        });

        test("handles whitespace in function call", () => {
            const result = parseExpr("  event_context( e )  ");
            expect(result).toEqual({
                kind: "call",
                name: "event_context",
                args: [{ kind: "identifier", value: "e" }],
            });
        });

        test("handles whitespace around commas", () => {
            const result = parseExpr("foo( a , b , c )");
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [
                    { kind: "identifier", value: "a" },
                    { kind: "identifier", value: "b" },
                    { kind: "identifier", value: "c" },
                ],
            });
        });

        test("parses quoted string arguments", () => {
            const result = parseExpr('status(e, "active")');
            expect(result).toEqual({
                kind: "call",
                name: "status",
                args: [
                    { kind: "identifier", value: "e" },
                    { kind: "string", value: "active" },
                ],
            });
        });

        test("parses natural number arguments", () => {
            const result = parseExpr("photo(5)");
            expect(result).toEqual({
                kind: "call",
                name: "photo",
                args: [{ kind: "number", value: "5" }],
            });
        });

        test("parses zero as number", () => {
            const result = parseExpr("count(0)");
            expect(result).toEqual({
                kind: "call",
                name: "count",
                args: [{ kind: "number", value: "0" }],
            });
        });

        test("parses mixed arg types", () => {
            const result = parseExpr('foo("str", 42, x)');
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [
                    { kind: "string", value: "str" },
                    { kind: "number", value: "42" },
                    { kind: "identifier", value: "x" },
                ],
            });
        });

        test("parses numeric arguments including multi-digit (T5)", () => {
            const result = parseExpr("node(123)");
            expect(result).toEqual({
                kind: "call",
                name: "node",
                args: [{ kind: "number", value: "123" }],
            });
            
            // Verify canonicalization works
            expect(canonicalize("node(123)")).toBe("node(123)");
            expect(canonicalize("node( 456 )")).toBe("node(456)");
        });

        test("handles string escapes", () => {
            const result = parseExpr('msg("hello\\"world")');
            expect(result).toEqual({
                kind: "call",
                name: "msg",
                args: [{ kind: "string", value: 'hello"world' }],
            });
        });

        test("throws on empty string", () => {
            expect(() => parseExpr("")).toThrow("Expression cannot be empty");
        });

        test("throws on missing closing paren", () => {
            expect(() => parseExpr("foo(a")).toThrow("rparen");
        });

        test("throws on invalid identifier in atom", () => {
            expect(() => parseExpr("123invalid")).toThrow("Invalid identifier");
        });

        test("throws on invalid function name", () => {
            expect(() => parseExpr("123foo(x)")).toThrow("identifier");
        });

        test("throws on leading zeros in numbers", () => {
            expect(() => parseExpr("foo(01)")).toThrow("leading zeros not allowed");
        });

        test("throws on unclosed string", () => {
            expect(() => parseExpr('foo("unclosed')).toThrow("Unclosed string");
        });
    });

    describe("canonicalize()", () => {
        test("canonicalizes an atom", () => {
            expect(canonicalize("all_events")).toBe("all_events");
            expect(canonicalize("  all_events  ")).toBe("all_events");
        });

        test("canonicalizes empty argument list (T4)", () => {
            expect(canonicalize("foo()")).toBe("foo()");
            expect(canonicalize("foo( )")).toBe("foo()");
        });

        test("canonicalizes with single arg", () => {
            expect(canonicalize("event_context(e)")).toBe("event_context(e)");
            expect(canonicalize("event_context( e )")).toBe("event_context(e)");
        });

        test("canonicalizes with multiple args", () => {
            expect(canonicalize("foo(a,b,c)")).toBe("foo(a,b,c)");
            expect(canonicalize("foo( a , b , c )")).toBe("foo(a,b,c)");
            expect(canonicalize(" foo ( a , b , c ) ")).toBe("foo(a,b,c)");
        });

        test("canonicalizes quoted strings", () => {
            expect(canonicalize('status(e, "active")')).toBe("status(e,'active')");
            expect(canonicalize('foo( "a" , "b" )')).toBe("foo('a','b')");
        });

        test("canonicalizes numbers", () => {
            expect(canonicalize("photo(5)")).toBe("photo(5)");
            expect(canonicalize("photo( 42 )")).toBe("photo(42)");
            expect(canonicalize("count(0)")).toBe("count(0)");
        });

        test("canonicalizes mixed arg types", () => {
            expect(canonicalize('mix("str", 5, x)')).toBe("mix('str',5,x)");
        });

        test("preserves string escapes in canonical form", () => {
            expect(canonicalize('foo("a\\"b")')).toBe("foo('a\"b')");
            expect(canonicalize('foo("line\\n")')).toBe("foo('line\\n')");
        });

        test("throws on malformed expression", () => {
            expect(() => canonicalize("")).toThrow();
            expect(() => canonicalize("foo(")).toThrow();
        });
    });
});
