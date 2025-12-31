/**
 * Tests for expression parsing and canonicalization.
 */

const {
    parseExpr,
    canonicalize,
    isConstantExpr,
    isCallExpr,
} = require("../src/generators/dependency_graph/expression");

describe("expression parsing", () => {
    describe("parseExpr()", () => {
        test("parses simple constant", () => {
            const expr = parseExpr("all_events");
            expect(expr.kind).toBe("constant");
            expect(expr.name).toBe("all_events");
        });

        test("parses constant with numbers", () => {
            const expr = parseExpr("event123");
            expect(expr.kind).toBe("constant");
            expect(expr.name).toBe("event123");
        });

        test("parses call with one argument", () => {
            const expr = parseExpr("event_context(e)");
            expect(expr.kind).toBe("call");
            expect(expr.name).toBe("event_context");
            expect(expr.args).toEqual(["e"]);
        });

        test("parses call with multiple arguments", () => {
            const expr = parseExpr("enhanced_event(e, p)");
            expect(expr.kind).toBe("call");
            expect(expr.name).toBe("enhanced_event");
            expect(expr.args).toEqual(["e", "p"]);
        });

        test("parses call with no spaces", () => {
            const expr = parseExpr("enhanced_event(e,p)");
            expect(expr.kind).toBe("call");
            expect(expr.name).toBe("enhanced_event");
            expect(expr.args).toEqual(["e", "p"]);
        });

        test("parses call with concrete arguments", () => {
            const expr = parseExpr("event_context(id123)");
            expect(expr.kind).toBe("call");
            expect(expr.name).toBe("event_context");
            expect(expr.args).toEqual(["id123"]);
        });

        test("handles extra whitespace in constant", () => {
            const expr = parseExpr("  all_events  ");
            expect(expr.kind).toBe("constant");
            expect(expr.name).toBe("all_events");
        });

        test("handles extra whitespace in call", () => {
            const expr = parseExpr("  event_context ( e ) ");
            expect(expr.kind).toBe("call");
            expect(expr.name).toBe("event_context");
            expect(expr.args).toEqual(["e"]);
        });

        test("throws on empty string", () => {
            expect(() => parseExpr("")).toThrow("Expression cannot be empty");
        });

        test("throws on whitespace only", () => {
            expect(() => parseExpr("   ")).toThrow(
                "Expression cannot be empty"
            );
        });

        test("throws on invalid constant (contains special chars)", () => {
            expect(() => parseExpr("event-name")).toThrow(
                "Invalid constant expression"
            );
        });

        test("throws on invalid function name", () => {
            expect(() => parseExpr("event-name(x)")).toThrow(
                "Invalid function name"
            );
        });

        test("throws on missing closing paren", () => {
            expect(() => parseExpr("event_context(e")).toThrow(
                "Missing closing parenthesis"
            );
        });

        test("throws on empty argument list", () => {
            expect(() => parseExpr("event_context()")).toThrow(
                "Empty argument list not allowed"
            );
        });

        test("throws on invalid argument", () => {
            expect(() => parseExpr("event_context(e-val)")).toThrow(
                "Invalid argument"
            );
        });

        test("throws on invalid argument in multi-arg call", () => {
            expect(() => parseExpr("enhanced(e, p-val)")).toThrow(
                "Invalid argument"
            );
        });
    });

    describe("canonicalize()", () => {
        test("canonicalizes constant", () => {
            expect(canonicalize("all_events")).toBe("all_events");
        });

        test("canonicalizes constant with whitespace", () => {
            expect(canonicalize("  all_events  ")).toBe("all_events");
        });

        test("canonicalizes call with one arg", () => {
            expect(canonicalize("event_context(e)")).toBe("event_context(e)");
        });

        test("canonicalizes call removing whitespace", () => {
            expect(canonicalize("event_context( e )")).toBe(
                "event_context(e)"
            );
        });

        test("canonicalizes call with multiple args", () => {
            expect(canonicalize("enhanced_event(e, p)")).toBe(
                "enhanced_event(e,p)"
            );
        });

        test("canonicalizes call with extra spaces", () => {
            expect(canonicalize(" enhanced_event ( e , p ) ")).toBe(
                "enhanced_event(e,p)"
            );
        });

        test("canonicalizes call with concrete args", () => {
            expect(canonicalize("event_context(id123)")).toBe(
                "event_context(id123)"
            );
        });

        test("multiple calls with same semantic form produce same canonical", () => {
            const forms = [
                "enhanced(e,p)",
                "enhanced( e , p )",
                "enhanced(e, p)",
                " enhanced ( e , p ) ",
            ];

            const canonicals = forms.map(canonicalize);
            expect(canonicals.every((c) => c === "enhanced(e,p)")).toBe(true);
        });
    });

    describe("type guards", () => {
        test("isConstantExpr identifies constants", () => {
            const expr = parseExpr("all_events");
            expect(isConstantExpr(expr)).toBe(true);
            expect(isCallExpr(expr)).toBe(false);
        });

        test("isCallExpr identifies calls", () => {
            const expr = parseExpr("event_context(e)");
            expect(isCallExpr(expr)).toBe(true);
            expect(isConstantExpr(expr)).toBe(false);
        });
    });
});
