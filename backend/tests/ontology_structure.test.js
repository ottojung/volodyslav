const ontology = require("../src/ontology");

describe("ontology structure", () => {
    describe("serialize", () => {
        it("should serialize an ontology with types and modifiers", () => {
            const ontologyObj = {
                types: [
                    { name: "food", description: "Food consumed by the user." },
                    { name: "weight", description: "Body weight in kilograms." },
                ],
                modifiers: [
                    { name: "when", description: "Time offset from logging, e.g. '1 hour ago'." },
                    { name: "duration", only_for_type: "food", description: "How long eating took." },
                ],
            };

            const result = ontology.serialize(ontologyObj);

            expect(result).toEqual({
                types: [
                    { name: "food", description: "Food consumed by the user." },
                    { name: "weight", description: "Body weight in kilograms." },
                ],
                modifiers: [
                    { name: "when", description: "Time offset from logging, e.g. '1 hour ago'." },
                    { name: "duration", only_for_type: "food", description: "How long eating took." },
                ],
            });
        });

        it("should serialize an empty ontology", () => {
            const result = ontology.serialize({ types: [], modifiers: [] });
            expect(result).toEqual({ types: [], modifiers: [] });
        });

        it("should omit only_for_type when absent from a modifier", () => {
            const ontologyObj = {
                types: [],
                modifiers: [{ name: "when", description: "Time offset." }],
            };
            const result = ontology.serialize(ontologyObj);
            expect(result.modifiers[0]).not.toHaveProperty("only_for_type");
        });

        it("should include only_for_type when present in a modifier", () => {
            const ontologyObj = {
                types: [],
                modifiers: [{ name: "duration", only_for_type: "food", description: "Duration." }],
            };
            const result = ontology.serialize(ontologyObj);
            expect(result.modifiers[0].only_for_type).toBe("food");
        });
    });

    describe("deserialize", () => {
        it("should deserialize a serialized ontology back to object format", () => {
            const serialized = {
                types: [{ name: "food", description: "Food entries." }],
                modifiers: [
                    { name: "when", description: "When it happened." },
                    { name: "duration", only_for_type: "food", description: "Duration." },
                ],
            };

            const result = ontology.deserialize(serialized);

            expect(result).toEqual(serialized);
        });

        it("should deserialize an empty ontology", () => {
            const result = ontology.deserialize({ types: [], modifiers: [] });
            expect(result).toEqual({ types: [], modifiers: [] });
        });
    });

    describe("tryDeserialize", () => {
        it("should deserialize a valid ontology object", () => {
            const validObj = {
                types: [
                    { name: "food", description: "Food entries." },
                ],
                modifiers: [
                    { name: "when", description: "When it happened." },
                    { name: "duration", only_for_type: "food", description: "Eating duration." },
                ],
            };

            const result = ontology.tryDeserialize(validObj);

            expect(ontology.isTryDeserializeError(result)).toBe(false);
            expect(result).toEqual(validObj);
        });

        it("should deserialize an empty ontology", () => {
            const result = ontology.tryDeserialize({ types: [], modifiers: [] });
            expect(ontology.isTryDeserializeError(result)).toBe(false);
            expect(result).toEqual({ types: [], modifiers: [] });
        });

        it("should return error for null", () => {
            const result = ontology.tryDeserialize(null);
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error for non-object types", () => {
            const invalids = [undefined, "string", 123, true, []];
            invalids.forEach((val) => {
                const result = ontology.tryDeserialize(val);
                expect(ontology.isTryDeserializeError(result)).toBe(true);
            });
        });

        it("should return error when types field is missing", () => {
            const result = ontology.tryDeserialize({ modifiers: [] });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when modifiers field is missing", () => {
            const result = ontology.tryDeserialize({ types: [] });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when types is not an array", () => {
            const result = ontology.tryDeserialize({ types: "food", modifiers: [] });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when modifiers is not an array", () => {
            const result = ontology.tryDeserialize({ types: [], modifiers: {} });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when a type entry is missing name", () => {
            const result = ontology.tryDeserialize({
                types: [{ description: "No name." }],
                modifiers: [],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when a type entry is missing description", () => {
            const result = ontology.tryDeserialize({
                types: [{ name: "food" }],
                modifiers: [],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when a type entry name is not a string", () => {
            const result = ontology.tryDeserialize({
                types: [{ name: 42, description: "desc" }],
                modifiers: [],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when a modifier entry is missing name", () => {
            const result = ontology.tryDeserialize({
                types: [],
                modifiers: [{ description: "No name." }],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when a modifier entry is missing description", () => {
            const result = ontology.tryDeserialize({
                types: [],
                modifiers: [{ name: "when" }],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should return error when only_for_type is provided but not a string", () => {
            const result = ontology.tryDeserialize({
                types: [],
                modifiers: [{ name: "duration", description: "dur", only_for_type: 42 }],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(true);
        });

        it("should accept modifier without only_for_type", () => {
            const result = ontology.tryDeserialize({
                types: [],
                modifiers: [{ name: "when", description: "When." }],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(false);
        });

        it("should accept modifier with valid only_for_type", () => {
            const result = ontology.tryDeserialize({
                types: [{ name: "food", description: "Food." }],
                modifiers: [{ name: "duration", description: "dur", only_for_type: "food" }],
            });
            expect(ontology.isTryDeserializeError(result)).toBe(false);
        });

        it("should return error when type array contains non-object elements", () => {
            const invalids = [
                { types: [null], modifiers: [] },
                { types: [42], modifiers: [] },
                { types: ["string"], modifiers: [] },
                { types: [[]], modifiers: [] },
            ];
            invalids.forEach((obj) => {
                const result = ontology.tryDeserialize(obj);
                expect(ontology.isTryDeserializeError(result)).toBe(true);
            });
        });

        it("should return error when modifier array contains non-object elements", () => {
            const invalids = [
                { types: [], modifiers: [null] },
                { types: [], modifiers: [42] },
                { types: [], modifiers: ["string"] },
            ];
            invalids.forEach((obj) => {
                const result = ontology.tryDeserialize(obj);
                expect(ontology.isTryDeserializeError(result)).toBe(true);
            });
        });
    });

    describe("roundtrip serialization", () => {
        it("should maintain data integrity through serialize/deserialize cycle", () => {
            const originalOntology = {
                types: [
                    { name: "food", description: "Food eaten by user." },
                    { name: "weight", description: "Body weight in kg." },
                ],
                modifiers: [
                    { name: "when", description: "Time offset from logging." },
                    { name: "duration", only_for_type: "food", description: "Eating duration." },
                    { name: "amount", description: "Quantity of the item." },
                ],
            };

            const serialized = ontology.serialize(originalOntology);
            const deserialized = ontology.deserialize(serialized);

            expect(deserialized).toEqual(originalOntology);
        });

        it("should work with tryDeserialize", () => {
            const originalOntology = {
                types: [{ name: "food", description: "Food." }],
                modifiers: [{ name: "when", description: "When." }],
            };

            const serialized = ontology.serialize(originalOntology);
            const result = ontology.tryDeserialize(serialized);

            expect(ontology.isTryDeserializeError(result)).toBe(false);
            expect(result).toEqual(originalOntology);
        });
    });
});
