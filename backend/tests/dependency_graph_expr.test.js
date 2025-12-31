/**
 * Tests for dependency_graph/expr module.
 */

const { parseExpr, canonicalize } = require("../src/generators/dependency_graph/expr");

describe("dependency_graph/expr", () => {
    describe("parseExpr() - Basic Identifiers", () => {
        test("parses a head-only constant (identifier)", () => {
            const result = parseExpr("all_events");
            expect(result).toEqual({
                kind: "const",
                name: "all_events",
                args: [],
            });
        });

        test("parses a function call with no args", () => {
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
                args: [{ kind: "var", name: "e" }],
            });
        });

        test("parses a function call with multiple identifier args", () => {
            const result = parseExpr("enhanced_event(e,p)");
            expect(result).toEqual({
                kind: "call",
                name: "enhanced_event",
                args: [
                    { kind: "var", name: "e" },
                    { kind: "var", name: "p" },
                ],
            });
        });

        test("handles whitespace in head-only constant", () => {
            const result = parseExpr("  all_events  ");
            expect(result).toEqual({
                kind: "const",
                name: "all_events",
                args: [],
            });
        });

        test("handles whitespace in function call", () => {
            const result = parseExpr("  event_context( e )  ");
            expect(result).toEqual({
                kind: "call",
                name: "event_context",
                args: [{ kind: "var", name: "e" }],
            });
        });

        test("handles whitespace around commas", () => {
            const result = parseExpr("foo( a , b , c )");
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [
                    { kind: "var", name: "a" },
                    { kind: "var", name: "b" },
                    { kind: "var", name: "c" },
                ],
            });
        });
    });

    describe("parseExpr() - String Literals", () => {
        test("parses string literal argument", () => {
            const result = parseExpr('status(e,"active")');
            expect(result).toEqual({
                kind: "call",
                name: "status",
                args: [
                    { kind: "var", name: "e" },
                    { kind: "const", value: { kind: "string", value: "active" } },
                ],
            });
        });

        test("parses empty string literal", () => {
            const result = parseExpr('foo("")');
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [{ kind: "const", value: { kind: "string", value: "" } }],
            });
        });

        test("parses string with spaces", () => {
            const result = parseExpr('foo("hello world")');
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [
                    { kind: "const", value: { kind: "string", value: "hello world" } },
                ],
            });
        });

        test("parses string with escaped quote", () => {
            const result = parseExpr('foo("a\\"b")');
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [{ kind: "const", value: { kind: "string", value: 'a"b' } }],
            });
        });

        test("parses string with escaped backslash", () => {
            const result = parseExpr('foo("a\\\\b")');
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [{ kind: "const", value: { kind: "string", value: "a\\b" } }],
            });
        });

        test("throws on unclosed string", () => {
            expect(() => parseExpr('foo("unclosed')).toThrow("Unclosed string");
        });

        test("throws on invalid escape sequence", () => {
            expect(() => parseExpr('foo("\\n")')).toThrow("Invalid escape sequence");
        });
    });

    describe("parseExpr() - Natural Numbers", () => {
        test("parses natural number 0", () => {
            const result = parseExpr("photo(0)");
            expect(result).toEqual({
                kind: "call",
                name: "photo",
                args: [{ kind: "const", value: { kind: "nat", value: 0 } }],
            });
        });

        test("parses single-digit natural number", () => {
            const result = parseExpr("photo(5)");
            expect(result).toEqual({
                kind: "call",
                name: "photo",
                args: [{ kind: "const", value: { kind: "nat", value: 5 } }],
            });
        });

        test("parses multi-digit natural number", () => {
            const result = parseExpr("photo(42)");
            expect(result).toEqual({
                kind: "call",
                name: "photo",
                args: [{ kind: "const", value: { kind: "nat", value: 42 } }],
            });
        });

        test("parses large natural number", () => {
            const result = parseExpr("photo(999)");
            expect(result).toEqual({
                kind: "call",
                name: "photo",
                args: [{ kind: "const", value: { kind: "nat", value: 999 } }],
            });
        });

        test("throws on leading zeros", () => {
            expect(() => parseExpr("photo(01)")).toThrow("leading zeros");
        });

        test("throws on negative number", () => {
            expect(() => parseExpr("photo(-1)")).toThrow("signed numbers not allowed");
        });

        test("throws on positive sign", () => {
            expect(() => parseExpr("photo(+1)")).toThrow("signed numbers not allowed");
        });

        test("throws on decimal number", () => {
            expect(() => parseExpr("photo(1.0)")).toThrow("only natural numbers");
        });

        test("throws on exponent notation", () => {
            expect(() => parseExpr("photo(1e3)")).toThrow("only natural numbers");
        });
    });

    describe("parseExpr() - Mixed Arguments", () => {
        test("parses mixed identifier, string, and number", () => {
            const result = parseExpr('foo("a",5,x)');
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [
                    { kind: "const", value: { kind: "string", value: "a" } },
                    { kind: "const", value: { kind: "nat", value: 5 } },
                    { kind: "var", name: "x" },
                ],
            });
        });

        test("parses with whitespace", () => {
            const result = parseExpr('  foo(  "a" ,  5 ,  x  )  ');
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [
                    { kind: "const", value: { kind: "string", value: "a" } },
                    { kind: "const", value: { kind: "nat", value: 5 } },
                    { kind: "var", name: "x" },
                ],
            });
        });
    });

    describe("parseExpr() - Error Cases", () => {
        test("throws on empty string", () => {
            expect(() => parseExpr("")).toThrow("Expression cannot be empty");
        });

        test("throws on whitespace-only string", () => {
            expect(() => parseExpr("   ")).toThrow("Expression cannot be empty");
        });

        test("throws on missing closing paren", () => {
            expect(() => parseExpr("foo(a")).toThrow("Expected ')'");
        });

        test("throws on expression starting with number", () => {
            expect(() => parseExpr("123foo()")).toThrow(
                "Expression must start with an identifier"
            );
        });

        test("throws on expression starting with string", () => {
            expect(() => parseExpr('"foo"')).toThrow(
                "Expression must start with an identifier"
            );
        });

        test("throws on unexpected token after expression", () => {
            expect(() => parseExpr("foo()bar")).toThrow("Unexpected token");
        });

        test("throws on unexpected character", () => {
            expect(() => parseExpr("foo(@)")).toThrow("Unexpected character");
        });
    });

    describe("canonicalize()", () => {
        test("canonicalizes head-only constant", () => {
            expect(canonicalize("all_events")).toBe("all_events");
            expect(canonicalize("  all_events  ")).toBe("all_events");
        });

        test("canonicalizes empty call", () => {
            expect(canonicalize("foo()")).toBe("foo()");
            expect(canonicalize("foo( )")).toBe("foo()");
        });

        test("canonicalizes identifiers", () => {
            expect(canonicalize("event_context(e)")).toBe("event_context(e)");
            expect(canonicalize("event_context( e )")).toBe("event_context(e)");
        });

        test("canonicalizes multiple identifiers", () => {
            expect(canonicalize("foo(a,b,c)")).toBe("foo(a,b,c)");
            expect(canonicalize("foo( a , b , c )")).toBe("foo(a,b,c)");
            expect(canonicalize(" foo ( a , b , c ) ")).toBe("foo(a,b,c)");
        });

        test("canonicalizes string literals", () => {
            expect(canonicalize('status(e,"active")')).toBe('status(e,"active")');
            expect(canonicalize('status( e , "active" )')).toBe('status(e,"active")');
        });

        test("canonicalizes string with escaped quote", () => {
            expect(canonicalize('foo("a\\"b")')).toBe('foo("a\\"b")');
        });

        test("canonicalizes string with escaped backslash", () => {
            expect(canonicalize('foo("a\\\\b")')).toBe('foo("a\\\\b")');
        });

        test("canonicalizes natural numbers", () => {
            expect(canonicalize("photo(0)")).toBe("photo(0)");
            expect(canonicalize("photo(42)")).toBe("photo(42)");
            expect(canonicalize("photo( 42 )")).toBe("photo(42)");
        });

        test("canonicalizes mixed arguments", () => {
            expect(canonicalize('foo( "a" ,  5 , x )')).toBe('foo("a",5,x)');
        });

        test("throws on malformed expression", () => {
            expect(() => canonicalize("")).toThrow();
            expect(() => canonicalize("foo(")).toThrow();
            expect(() => canonicalize("photo(-1)")).toThrow();
            expect(() => canonicalize("photo(1.0)")).toThrow();
        });
    });
});
