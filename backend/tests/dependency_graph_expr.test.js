/**
 * Tests for dependency_graph/expr module.
 */

const { parseExpr, canonicalize } = require("../src/generators/dependency_graph/expr");

describe("dependency_graph/expr", () => {
    describe("parseExpr()", () => {
        test("parses a constant", () => {
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

        test("parses a function call with one arg", () => {
            const result = parseExpr("event_context(e)");
            expect(result).toEqual({
                kind: "call",
                name: "event_context",
                args: ["e"],
            });
        });

        test("parses a function call with multiple args", () => {
            const result = parseExpr("enhanced_event(e,p)");
            expect(result).toEqual({
                kind: "call",
                name: "enhanced_event",
                args: ["e", "p"],
            });
        });

        test("handles whitespace in constant", () => {
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
                args: ["e"],
            });
        });

        test("handles whitespace around commas", () => {
            const result = parseExpr("foo( a , b , c )");
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: ["a", "b", "c"],
            });
        });

        test("throws on empty string", () => {
            expect(() => parseExpr("")).toThrow("Expression cannot be empty");
        });

        test("throws on missing closing paren", () => {
            expect(() => parseExpr("foo(a")).toThrow("Missing closing parenthesis");
        });

        test("throws on invalid identifier in constant", () => {
            expect(() => parseExpr("123invalid")).toThrow("Invalid identifier");
        });

        test("throws on invalid function name", () => {
            expect(() => parseExpr("123foo()")).toThrow("Invalid function name");
        });

        test("throws on invalid argument", () => {
            expect(() => parseExpr("foo(123)")).toThrow("Invalid argument");
        });
    });

    describe("canonicalize()", () => {
        test("canonicalizes a constant", () => {
            expect(canonicalize("all_events")).toBe("all_events");
            expect(canonicalize("  all_events  ")).toBe("all_events");
        });

        test("canonicalizes a function call", () => {
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

        test("throws on malformed expression", () => {
            expect(() => canonicalize("")).toThrow();
            expect(() => canonicalize("foo(")).toThrow();
        });
    });
});
