/**
 * Tests for useDiaryLiveQuestioningController pure helpers:
 * mergeTranscriptionWindow, tokensToText, and their interaction.
 */

import {
    mergeTranscriptionWindow,
    tokensToText,
} from "../src/AudioDiary/useDiaryLiveQuestioningController.js";

/** @typedef {import('../src/AudioDiary/diary_live_api.js').TranscriptToken} TranscriptToken */

// ─── mergeTranscriptionWindow ─────────────────────────────────────────────────

describe("mergeTranscriptionWindow", () => {
    /** @param {string} text @param {number} start @param {number} end @returns {TranscriptToken} */
    function token(text, start, end) {
        return { text, startMs: start, endMs: end };
    }

    it("inserts incoming tokens into an empty list", () => {
        const result = mergeTranscriptionWindow(
            [],
            [token("hello", 0, 1000), token("world", 1000, 2000)],
            0,
            10000
        );
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe("hello");
    });

    it("replaces tokens that overlap the window zone", () => {
        const existing = [
            token("before", 0, 5000),
            token("overlap", 5000, 15000),
            token("after", 20000, 30000),
        ];
        const incoming = [token("new", 5000, 15000)];
        const result = mergeTranscriptionWindow(existing, incoming, 5000, 15000);
        const texts = result.map((t) => t.text);
        expect(texts).toContain("before");
        expect(texts).toContain("new");
        expect(texts).toContain("after");
        expect(texts).not.toContain("overlap");
    });

    it("keeps tokens entirely before the window zone", () => {
        const existing = [token("early", 0, 4999)];
        const incoming = [token("fresh", 5000, 10000)];
        const result = mergeTranscriptionWindow(existing, incoming, 5000, 10000);
        expect(result.map((t) => t.text)).toEqual(["early", "fresh"]);
    });

    it("keeps tokens entirely after the window zone", () => {
        const existing = [token("late", 20001, 30000)];
        const incoming = [token("fresh", 5000, 10000)];
        const result = mergeTranscriptionWindow(existing, incoming, 5000, 10000);
        expect(result.map((t) => t.text)).toEqual(["fresh", "late"]);
    });

    it("sorts merged tokens by startMs", () => {
        const existing = [token("c", 20000, 30000)];
        const incoming = [token("a", 0, 5000), token("b", 5000, 10000)];
        const result = mergeTranscriptionWindow(existing, incoming, 0, 10000);
        expect(result.map((t) => t.text)).toEqual(["a", "b", "c"]);
    });

    it("handles consecutive non-overlapping windows accumulating text", () => {
        // Milestone 1: window [0, 10000]
        const window1Tokens = [token("I", 0, 2000), token("walked", 2000, 5000)];
        const after1 = mergeTranscriptionWindow([], window1Tokens, 0, 10000);

        // Milestone 2: window [0, 20000] (overlapping) with revised + new tokens
        const window2Tokens = [
            token("I", 0, 2000),
            token("walked", 2000, 5000),
            token("to", 10000, 12000),
            token("the", 12000, 14000),
            token("store", 14000, 16000),
        ];
        const after2 = mergeTranscriptionWindow(after1, window2Tokens, 0, 20000);

        expect(tokensToText(after2)).toBe("I walked to the store");
    });
});

// ─── tokensToText ─────────────────────────────────────────────────────────────

describe("tokensToText", () => {
    it("returns empty string for empty token list", () => {
        expect(tokensToText([])).toBe("");
    });

    it("joins tokens with a single space", () => {
        const tokens = [
            { text: "Hello", startMs: 0, endMs: 500 },
            { text: "world", startMs: 500, endMs: 1000 },
        ];
        expect(tokensToText(tokens)).toBe("Hello world");
    });

    it("trims whitespace from each token", () => {
        const tokens = [
            { text: "  Hello  ", startMs: 0, endMs: 500 },
            { text: " world ", startMs: 500, endMs: 1000 },
        ];
        expect(tokensToText(tokens)).toBe("Hello world");
    });

    it("filters out empty tokens", () => {
        const tokens = [
            { text: "Hello", startMs: 0, endMs: 500 },
            { text: "", startMs: 500, endMs: 600 },
            { text: "world", startMs: 600, endMs: 1000 },
        ];
        expect(tokensToText(tokens)).toBe("Hello world");
    });
});
