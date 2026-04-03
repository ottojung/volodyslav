const { makeComputor, makeBox } = require("../src/generators/individual/ontology/wrapper");
const { isUnchanged } = require("../src/generators/incremental_graph");

describe("ontology wrapper", () => {
    test("returns empty ontology when there is no old value and no explicit set", async () => {
        const box = makeBox();
        const computor = makeComputor(box, {});
        const result = await computor([], undefined, []);
        expect(result).toEqual({ type: "ontology", ontology: { types: [], modifiers: [] } });
    });

    test("preserves persisted old value when box is unset", async () => {
        const box = makeBox();
        const computor = makeComputor(box, {});
        const oldValue = {
            type: "ontology",
            ontology: {
                types: [{ name: "food", description: "Persisted" }],
                modifiers: [{ name: "when", description: "Persisted modifier" }],
            },
        };
        const result = await computor([], oldValue, []);
        expect(isUnchanged(result)).toBe(true);
    });
});
