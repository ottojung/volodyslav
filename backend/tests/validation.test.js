/**
 * Tests for schema validation.
 */

const {
    validateInputVariablesCovered,
    validateSchemasMutuallyExclusive,
    validateSchemas,
    isSchemaValidationError,
} = require("../src/generators/dependency_graph/validation");

describe("schema validation", () => {
    describe("validateInputVariablesCovered()", () => {
        test("accepts schema with no variables", () => {
            const schema = {
                output: "all_events",
                inputs: [],
                variables: [],
                computor: () => ({}),
            };

            expect(() =>
                validateInputVariablesCovered(schema)
            ).not.toThrow();
        });

        test("accepts schema where output variables cover input variables", () => {
            const schema = {
                output: "enhanced_event(e,p)",
                inputs: ["event_context(e)", "photo(p)"],
                variables: ["e", "p"],
                computor: () => ({}),
            };

            expect(() =>
                validateInputVariablesCovered(schema)
            ).not.toThrow();
        });

        test("accepts schema with constants in inputs", () => {
            const schema = {
                output: "active_metadata(e)",
                inputs: ["metadata(e)", "status(e,active)"],
                variables: ["e"],
                computor: () => ({}),
            };

            expect(() =>
                validateInputVariablesCovered(schema)
            ).not.toThrow();
        });

        test("rejects schema where input variable not in output", () => {
            const schema = {
                output: "derived_event(x)",
                inputs: ["event_context(e)"],
                variables: ["e", "x"],
                computor: () => ({}),
            };

            expect(() => validateInputVariablesCovered(schema)).toThrow(
                /uses variable "e" which does not appear in output/
            );
        });

        test("accepts schema where input is constant", () => {
            const schema = {
                output: "meta_events",
                inputs: ["all_events"],
                variables: [],
                computor: () => ({}),
            };

            expect(() =>
                validateInputVariablesCovered(schema)
            ).not.toThrow();
        });
    });

    describe("validateSchemasMutuallyExclusive()", () => {
        test("accepts schemas with different heads", () => {
            const schemas = [
                {
                    output: "node_a(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "node_b(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
            ];

            expect(() =>
                validateSchemasMutuallyExclusive(schemas)
            ).not.toThrow();
        });

        test("accepts schemas with different arities", () => {
            const schemas = [
                {
                    output: "node(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "node(x,y)",
                    inputs: [],
                    variables: ["x", "y"],
                    computor: () => ({}),
                },
            ];

            expect(() =>
                validateSchemasMutuallyExclusive(schemas)
            ).not.toThrow();
        });

        test("accepts schemas with non-overlapping constant arguments", () => {
            const schemas = [
                {
                    output: "status(e,active)",
                    inputs: [],
                    variables: ["e"],
                    computor: () => ({}),
                },
                {
                    output: "status(e,inactive)",
                    inputs: [],
                    variables: ["e"],
                    computor: () => ({}),
                },
            ];

            expect(() =>
                validateSchemasMutuallyExclusive(schemas)
            ).not.toThrow();
        });

        test("rejects duplicate constant schemas", () => {
            const schemas = [
                {
                    output: "all_events",
                    inputs: [],
                    variables: [],
                    computor: () => ({}),
                },
                {
                    output: "all_events",
                    inputs: [],
                    variables: [],
                    computor: () => ({}),
                },
            ];

            expect(() => validateSchemasMutuallyExclusive(schemas)).toThrow(
                /not mutually exclusive/
            );
        });

        test("rejects overlapping parameterized schemas", () => {
            const schemas = [
                {
                    output: "node(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({ version: 1 }),
                },
                {
                    output: "node(y)",
                    inputs: [],
                    variables: ["y"],
                    computor: () => ({ version: 2 }),
                },
            ];

            expect(() => validateSchemasMutuallyExclusive(schemas)).toThrow(
                /not mutually exclusive/
            );
        });

        test("rejects schemas where one is more general", () => {
            const schemas = [
                {
                    output: "status(e,active)",
                    inputs: [],
                    variables: ["e"],
                    computor: () => ({}),
                },
                {
                    output: "status(x,y)",
                    inputs: [],
                    variables: ["x", "y"],
                    computor: () => ({}),
                },
            ];

            expect(() => validateSchemasMutuallyExclusive(schemas)).toThrow(
                /not mutually exclusive/
            );
        });
    });

    describe("validateSchemas()", () => {
        test("accepts valid schema set", () => {
            const schemas = [
                {
                    output: "all_events",
                    inputs: [],
                    variables: [],
                    computor: () => ({}),
                },
                {
                    output: "event_context(e)",
                    inputs: ["all_events"],
                    variables: ["e"],
                    computor: () => ({}),
                },
            ];

            expect(() => validateSchemas(schemas)).not.toThrow();
        });

        test("rejects schema with uncovered variable", () => {
            const schemas = [
                {
                    output: "node(x)",
                    inputs: ["dependency(y)"],
                    variables: ["x", "y"],
                    computor: () => ({}),
                },
            ];

            expect(() => validateSchemas(schemas)).toThrow(
                /uses variable "y" which does not appear in output/
            );
        });

        test("rejects overlapping schemas", () => {
            const schemas = [
                {
                    output: "node(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "node(y)",
                    inputs: [],
                    variables: ["y"],
                    computor: () => ({}),
                },
            ];

            expect(() => validateSchemas(schemas)).toThrow(
                /not mutually exclusive/
            );
        });
    });

    describe("error type guards", () => {
        test("isSchemaValidationError identifies errors", () => {
            const schemas = [
                {
                    output: "node(x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "node(y)",
                    inputs: [],
                    variables: ["y"],
                    computor: () => ({}),
                },
            ];

            try {
                validateSchemas(schemas);
                fail("Should have thrown");
            } catch (err) {
                expect(isSchemaValidationError(err)).toBe(true);
            }
        });
    });
});
