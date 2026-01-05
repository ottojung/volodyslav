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



        test("throws on empty string", () => {
            expect(() => parseExpr("")).toThrow("Expression cannot be empty");
        });

        test("throws on missing closing paren", () => {
            expect(() => parseExpr("foo(a")).toThrow("rparen");
        });

        test("throws on invalid identifier in atom", () => {
            expect(() => parseExpr("123invalid")).toThrow("Unexpected character");
        });

        test("throws on invalid function name", () => {
            expect(() => parseExpr("123foo(x)")).toThrow("Unexpected character");
        });
    });

    describe("canonicalize()", () => {
        test("canonicalizes an atom", () => {
            expect(canonicalize("all_events")).toBe("all_events");
            expect(canonicalize("  all_events  ")).toBe("all_events");
        });

        test("canonicalizes empty argument list to head/0", () => {
            expect(canonicalize("foo()")).toBe("foo");
            expect(canonicalize("foo( )")).toBe("foo");
        });

        test("canonicalizes to head/arity format", () => {
            expect(canonicalize("event_context(e)")).toBe("event_context");
            expect(canonicalize("event_context( e )")).toBe("event_context");
            expect(canonicalize("event_context(x)")).toBe("event_context");
        });

        test("canonicalizes with multiple args to head/arity", () => {
            expect(canonicalize("foo(a,b,c)")).toBe("foo");
            expect(canonicalize("foo( a , b , c )")).toBe("foo");
            expect(canonicalize(" foo ( a , b , c ) ")).toBe("foo");
        });

        test("variable names don't affect canonicalization", () => {
            expect(canonicalize("event_context(e)")).toBe("event_context");
            expect(canonicalize("event_context(x)")).toBe("event_context");
            expect(canonicalize("enhanced_event(e, p)")).toBe("enhanced_event");
            expect(canonicalize("enhanced_event(x, y)")).toBe("enhanced_event");
        });

        test("throws on malformed expression", () => {
            expect(() => canonicalize("")).toThrow();
            expect(() => canonicalize("foo(")).toThrow();
        });
    });
});
