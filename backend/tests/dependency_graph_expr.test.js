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

        test("accepts quoted string arguments", () => {
            expect(parseExpr('status(e, "active")')).toBeTruthy();
        });

        test("accepts natural number arguments", () => {
            expect(parseExpr("photo(5)")).toBeTruthy();
        });

        test("accepts zero as number", () => {
            expect(parseExpr("count(0)")).toBeTruthy();
        });

        test("accepts mixed arg types with constants and variables", () => {
            expect(parseExpr('foo("str", 42, x)')).toBeTruthy();
        });

        test("accepts numeric arguments including multi-digit", () => {
            expect(parseExpr("node(123)")).toBeTruthy();
        });

        test("accepts string escapes", () => {
            expect(parseExpr('msg("hello\\"world")')).toBeTruthy();
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

        test("accepts quoted strings", () => {
            expect(canonicalize('status(e, "active")')).toBe('status(e,"active")');
            expect(canonicalize('foo( "a" , "b" )')).toBe('foo("a","b")');
        });

        test("accepts numbers", () => {
            expect(canonicalize("photo(5)")).toBe("photo(5)");
            expect(canonicalize("photo( 42 )")).toBe("photo(42)");
            expect(canonicalize("count(0)")).toBe("count(0)");
        });

        test("accepts mixed arg types with constants and variables", () => {
            expect(canonicalize('mix("str", 5, x)')).toBe('mix("str",5,x)');
        });

        test("handles string escapes", () => {
            expect(canonicalize('foo("a\\"b")')).toBe('foo("a\\"b")');
            expect(canonicalize('foo("line\\n")')).toBe('foo("line\\n")');
        });

        test("throws on malformed expression", () => {
            expect(() => canonicalize("")).toThrow();
            expect(() => canonicalize("foo(")).toThrow();
        });
    });
});
