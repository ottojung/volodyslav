const { getEntryBasicContext } = require("../src/generators/entry_context");
const { fromISOString, fromMinutes } = require("../src/datetime");

describe("getEntryBasicContext", () => {
    const makeEntry = (id, input, date, type = "text") => ({
        id,
        input,
        date,
        type,
        original: input,
        modifiers: {},
        description: input,
        creator: { name: "test", uuid: "test-uuid", version: "1.0" },
    });

    it("returns empty array when entry has no hashtags", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");
        const targetEntry = makeEntry("target", "No hashtags", date);
        const allEntries = [
            makeEntry("1", "Earlier #work entry", date),
            targetEntry,
        ];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEntry);
    });

    it("returns entries with matching hashtags regardless of time", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #work entry", date1);
        const entry2 = makeEntry("2", "Another #work task", date2);
        const targetEntry = makeEntry("target", "Current #work status", date3);

        const allEntries = [entry1, entry2, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(3);
        expect(context).toContain(entry1);
        expect(context).toContain(entry2);
        expect(context).toContain(targetEntry);
    });

    it("includes entries regardless of time", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #work entry", date1);
        const targetEntry = makeEntry("target", "Current #work status", date2);
        const entry3 = makeEntry("3", "Later #work entry", date3);

        const allEntries = [entry1, targetEntry, entry3];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(3);
        expect(context).toContain(entry1);
        expect(context).toContain(targetEntry);
        expect(context).toContain(entry3);
    });

    it("excludes entries that do not share hashtags", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #meeting entry", date1);
        const targetEntry = makeEntry("target", "Current #work status", date2);

        const allEntries = [entry1, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEntry);
    });

    it("includes the target entry itself in context", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");
        const targetEntry = makeEntry("target", "Current #work status", date);
        const allEntries = [targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEntry);
    });

    it("includes entries with partial hashtag match", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #work #project entry", date1);
        const targetEntry = makeEntry(
            "target",
            "Current #work #meeting status",
            date2
        );

        const allEntries = [entry1, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(2);
        expect(context).toContain(entry1);
        expect(context).toContain(targetEntry);
    });

    it("excludes entries with non-context-enhancing types", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry(
            "1",
            "Earlier #work entry",
            date1,
            "non-enhancing"
        );
        const targetEntry = makeEntry("target", "Current #work status", date2);

        const allEntries = [entry1, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEntry);
    });

    it("includes entries with context-enhancing type 'text'", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #work entry", date1, "text");
        const targetEntry = makeEntry("target", "Current #work status", date2);

        const allEntries = [entry1, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(2);
        expect(context).toContain(entry1);
        expect(context).toContain(targetEntry);
    });

    it("includes entries with context-enhancing type 'reg'", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #work entry", date1, "reg");
        const targetEntry = makeEntry("target", "Current #work status", date2);

        const allEntries = [entry1, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(2);
        expect(context).toContain(entry1);
        expect(context).toContain(targetEntry);
    });

    it("handles multiple entries with various conditions", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));
        const date4 = date3.advance(fromMinutes(10));
        const date5 = date4.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #work entry", date1, "text");
        const entry2 = makeEntry("2", "Another #meeting entry", date2, "text");
        const entry3 = makeEntry("3", "Mixed #work #meeting", date3, "text");
        const targetEntry = makeEntry(
            "target",
            "Current #work status",
            date4,
            "text"
        );
        const entry5 = makeEntry("5", "Later #work entry", date5, "text");

        const allEntries = [entry1, entry2, entry3, targetEntry, entry5];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(4);
        expect(context).toContain(entry1);
        expect(context).toContain(entry3);
        expect(context).toContain(targetEntry);
        expect(context).toContain(entry5);
        expect(context).not.toContain(entry2); // No shared hashtags
    });

    it("includes entries at exactly the same time", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");

        const entry1 = makeEntry("1", "Concurrent #work entry", date);
        const targetEntry = makeEntry("target", "Current #work status", date);

        const allEntries = [entry1, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(2);
        expect(context).toContain(entry1);
        expect(context).toContain(targetEntry);
    });

    it("returns empty array when all entries is empty", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");
        const targetEntry = makeEntry("target", "Current #work status", date);
        const allEntries = [];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toEqual([]);
    });

    it("returns empty array when just an unmatched entry is present", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #Work entry", date1);
        const targetEntry = makeEntry("target", "Current #work status", date2);

        const allEntries = [entry1];

        // Hashtags are case-sensitive, so #Work and #work are different
        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(0);
    });

    it("handles hashtags with different cases", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #Work entry", date1);
        const targetEntry = makeEntry("target", "Current #work status", date2);

        const allEntries = [entry1, targetEntry];

        // Hashtags are case-sensitive, so #Work and #work are different
        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEntry);
    });

    it("handles multiple hashtags in both entries", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "Earlier #work #project #coding", date1);
        const targetEntry = makeEntry(
            "target",
            "Current #review #coding #testing",
            date2
        );

        const allEntries = [entry1, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(2);
        expect(context).toContain(entry1);
        expect(context).toContain(targetEntry);
    });

    it("returns entries in the order they appear in all_entries", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));
        const date4 = date3.advance(fromMinutes(10));

        const entry1 = makeEntry("1", "First #work entry", date1);
        const entry2 = makeEntry("2", "Second #work entry", date2);
        const entry3 = makeEntry("3", "Third #work entry", date3);
        const targetEntry = makeEntry("target", "Current #work status", date4);

        const allEntries = [entry1, entry2, entry3, targetEntry];

        const context = getEntryBasicContext(allEntries, targetEntry);
        expect(context).toHaveLength(4);
        expect(context[0]).toBe(entry1);
        expect(context[1]).toBe(entry2);
        expect(context[2]).toBe(entry3);
        expect(context[3]).toBe(targetEntry);
    });
});
