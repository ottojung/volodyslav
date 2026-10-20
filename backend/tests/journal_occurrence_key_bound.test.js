const {
    journalKeyToString,
    stringToJournalText,
} = require("../src/generators/incremental_graph/database");
const {
    makeJournalOccurrenceKey,
    readCurrentOccurrence,
} = require("../src/generators/incremental_graph/journal_store");

describe("bounded physical keys for current occurrence indices", () => {
    const small = { head: "event", args: ["abc"] };
    const large = { head: "event", args: ["x".repeat(100000)] };

    test("physical key size does not grow with semantic key length", () => {
        const shortKey = journalKeyToString(makeJournalOccurrenceKey(small));
        const longKey = journalKeyToString(makeJournalOccurrenceKey(large));
        expect(shortKey).toMatch(/^occurrence\|[a-f0-9]{64}$/);
        expect(longKey).toMatch(/^occurrence\|[a-f0-9]{64}$/);
        expect(shortKey.length).toBe(longKey.length);
        expect(longKey).not.toContain("x".repeat(100));
    });

    test("index refuses a stored identity that does not match the addressed node", async () => {
        const physicalKey = makeJournalOccurrenceKey(small);
        const conflicting = stringToJournalText(JSON.stringify({
            node: '{"head":"event","args":["different"]}',
            valueId: "aaaaaaaaa:1",
        }));
        const journal = {
            async get(key) {
                return key === physicalKey ? conflicting : undefined;
            },
        };
        const found = await readCurrentOccurrence(
            /** @type {any} */(journal),
            small
        );
        expect(found).toBeInstanceOf(Error);
        expect(found.message).toMatch(/collision/);
    });
});
