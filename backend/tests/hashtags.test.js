const { extractHashtags } = require("../src/event/hashtags");
const { make: makeDateTime } = require("../src/datetime");

describe("extractHashtags", () => {
    it("extracts a single hashtag from input", () => {
        const entry = {
            input: "This is a test with #hashtag",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(1);
        expect(hashtags.has("hashtag")).toBe(true);
    });

    it("extracts multiple hashtags from input", () => {
        const entry = {
            input: "Multiple tags: #first #second #third",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(3);
        expect(hashtags.has("first")).toBe(true);
        expect(hashtags.has("second")).toBe(true);
        expect(hashtags.has("third")).toBe(true);
    });

    it("returns empty set when no hashtags present", () => {
        const entry = {
            input: "No hashtags here",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(0);
    });

    it("deduplicates repeated hashtags", () => {
        const entry = {
            input: "Same tag twice: #duplicate and #duplicate again",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(1);
        expect(hashtags.has("duplicate")).toBe(true);
    });

    it("extracts hashtags with numbers", () => {
        const entry = {
            input: "Tags with numbers: #tag123 #456tag #tag456tag",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(3);
        expect(hashtags.has("tag123")).toBe(true);
        expect(hashtags.has("456tag")).toBe(true);
        expect(hashtags.has("tag456tag")).toBe(true);
    });

    it("handles hashtags at the beginning of input", () => {
        const entry = {
            input: "#start at the beginning",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(1);
        expect(hashtags.has("start")).toBe(true);
    });

    it("handles hashtags at the end of input", () => {
        const entry = {
            input: "ending with #end",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(1);
        expect(hashtags.has("end")).toBe(true);
    });

    it("handles consecutive hashtags without spaces", () => {
        const entry = {
            input: "consecutive#first#second#third",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(3);
        expect(hashtags.has("first")).toBe(true);
        expect(hashtags.has("second")).toBe(true);
        expect(hashtags.has("third")).toBe(true);
    });

    it("handles hashtags followed by punctuation", () => {
        const entry = {
            input: "Tag with punctuation: #tag1, #tag2! #tag3.",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        // All three should be recognized as "tag" and deduplicated
        expect(hashtags.size).toBe(3);
        expect(hashtags.has("tag1")).toBe(true);
        expect(hashtags.has("tag2")).toBe(true);
        expect(hashtags.has("tag3")).toBe(true);
    });

    it("handles hashtags in multi-line input", () => {
        const entry = {
            input: "Line 1 with #first\nLine 2 with #second\nLine 3 with #third",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(3);
        expect(hashtags.has("first")).toBe(true);
        expect(hashtags.has("second")).toBe(true);
        expect(hashtags.has("third")).toBe(true);
    });

    it("handles empty input", () => {
        const entry = {
            input: "",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(0);
    });

    it("ignores standalone hash symbols without words", () => {
        const entry = {
            input: "Just a # symbol or # # multiple",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(0);
    });

    it("extracts hashtags with underscores", () => {
        const entry = {
            input: "Tag with underscores: #tag_with_underscores",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(1);
        expect(hashtags.has("tag_with_underscores")).toBe(true);
    });

    it("handles mixed alphanumeric hashtags", () => {
        const entry = {
            input: "Mixed: #a1b2c3 #123abc #abc123def",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(3);
        expect(hashtags.has("a1b2c3")).toBe(true);
        expect(hashtags.has("123abc")).toBe(true);
        expect(hashtags.has("abc123def")).toBe(true);
    });

    it("handles hashtags surrounded by parentheses", () => {
        const entry = {
            input: "In parentheses (#tag) and [#another]",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(2);
        expect(hashtags.has("tag")).toBe(true);
        expect(hashtags.has("another")).toBe(true);
    });

    it("case sensitive hashtag extraction", () => {
        const entry = {
            input: "Case test: #Tag #tag #TAG",
            id: "test-id",
            date: makeDateTime(),
            original: "test",
            modifiers: {},
            type: "note",
            description: "test",
            creator: { name: "test", uuid: "test-uuid", version: "1.0" },
        };
        const hashtags = extractHashtags(entry);
        expect(hashtags.size).toBe(3);
        expect(hashtags.has("Tag")).toBe(true);
        expect(hashtags.has("tag")).toBe(true);
        expect(hashtags.has("TAG")).toBe(true);
    });
});
