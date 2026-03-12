/**
 * Table-driven tests for transcript gluing / overlap detection.
 */

const { glueTranscripts, extractWords } = require("../src/ai/transcription_glue");

// ---------------------------------------------------------------------------
// extractWords
// ---------------------------------------------------------------------------

describe("extractWords", () => {
    test("extracts words from simple ASCII text", () => {
        const words = extractWords("Hello world");
        expect(words.map(w => w.normalized)).toEqual(["hello", "world"]);
    });

    test("strips punctuation from normalized form", () => {
        const words = extractWords("Hello, world!");
        expect(words.map(w => w.normalized)).toEqual(["hello", "world"]);
    });

    test("end positions are correct", () => {
        const text = "abc def";
        const words = extractWords(text);
        expect(words[0].end).toBe(3);  // "abc" ends at index 3
        expect(words[1].end).toBe(7);  // "def" ends at index 7
    });

    test("handles Unicode CJK characters", () => {
        const words = extractWords("你好 世界");
        expect(words).toHaveLength(2);
        expect(words[0].normalized).toBe("你好");
    });

    test("handles Arabic text", () => {
        const words = extractWords("مرحبا بالعالم");
        expect(words).toHaveLength(2);
    });

    test("handles empty string", () => {
        expect(extractWords("")).toEqual([]);
    });

    test("handles whitespace-only string", () => {
        expect(extractWords("   ")).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// glueTranscripts – basic behaviour
// ---------------------------------------------------------------------------

describe("glueTranscripts – basic", () => {
    test("empty previousText returns currentText", () => {
        const r = glueTranscripts("", "hello world");
        expect(r.text).toBe("hello world");
        expect(r.overlapInfo.overlapWords).toBe(0);
    });

    test("empty currentText returns previousText", () => {
        const r = glueTranscripts("hello world", "");
        expect(r.text).toBe("hello world");
        expect(r.overlapInfo.overlapWords).toBe(0);
    });

    test("whitespace-only strings join safely", () => {
        const r = glueTranscripts("  ", "  ");
        expect(r.text).toBe("  ");
        expect(r.overlapInfo.overlapWords).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// glueTranscripts – exact overlap
// ---------------------------------------------------------------------------

describe("glueTranscripts – exact duplicated overlap", () => {
    test("removes exact duplicate suffix/prefix overlap", () => {
        const prev = "The quick brown fox";
        const curr = "brown fox jumps over";
        const r = glueTranscripts(prev, curr);
        expect(r.text).toBe("The quick brown fox jumps over");
        expect(r.overlapInfo.overlapWords).toBe(2);
    });

    test("handles longer overlap", () => {
        const prev = "one two three four five";
        const curr = "three four five six seven";
        const r = glueTranscripts(prev, curr);
        expect(r.text).toBe("one two three four five six seven");
        expect(r.overlapInfo.overlapWords).toBe(3);
    });

    test("does not produce double spaces at join point", () => {
        const prev = "Hello there";
        const curr = "there friend";
        const r = glueTranscripts(prev, curr);
        expect(r.text).not.toMatch(/\s{2}/);
    });
});

// ---------------------------------------------------------------------------
// glueTranscripts – punctuation / whitespace differences
// ---------------------------------------------------------------------------

describe("glueTranscripts – normalisation", () => {
    test("ignores punctuation differences in overlap matching", () => {
        const prev = "Well, hello there";
        const curr = "hello there. How are you?";
        const r = glueTranscripts(prev, curr);
        expect(r.overlapInfo.overlapWords).toBeGreaterThanOrEqual(2);
        expect(r.text).toContain("How are you");
    });

    test("ignores case differences when 2+ words overlap", () => {
        const prev = "Hello World today";
        const curr = "World today is beautiful";
        const r = glueTranscripts(prev, curr);
        expect(r.overlapInfo.overlapWords).toBeGreaterThanOrEqual(2);
        expect(r.text).toContain("is beautiful");
    });

    test("whitespace differences do not prevent matching", () => {
        const prev = "the cat sat on the mat";
        const curr = "the  mat  was  soft";  // double spaces
        const r = glueTranscripts(prev, curr);
        // "the mat" should match
        expect(r.overlapInfo.overlapWords).toBeGreaterThanOrEqual(2);
    });
});

// ---------------------------------------------------------------------------
// glueTranscripts – line break handling
// ---------------------------------------------------------------------------

describe("glueTranscripts – line breaks", () => {
    test("preserves trailing newline from previous text", () => {
        const prev = "first line\n";
        const curr = "second line";
        const r = glueTranscripts(prev, curr);
        expect(r.text).toContain("first line\n");
    });

    test("does not double-space when current starts with newline", () => {
        const prev = "hello world";
        const curr = "\nnext part";
        const r = glueTranscripts(prev, curr);
        expect(r.text).not.toMatch(/\s{2}/);
    });
});

// ---------------------------------------------------------------------------
// glueTranscripts – weak overlap that should not be removed
// ---------------------------------------------------------------------------

describe("glueTranscripts – weak overlap fallback", () => {
    test("does not remove single-word overlap (below minimum threshold)", () => {
        const prev = "The cat sat";
        const curr = "sat down quietly";
        // MIN_OVERLAP_WORDS is 2, so a 1-word match should NOT trigger removal
        // "sat" is the only shared word
        const r = glueTranscripts(prev, curr);
        // Either the overlap was removed (sat) or not – depends on whether there's a 2-word match.
        // There's no 2-word match here (prev ends in "cat sat", curr starts with "sat down").
        // So no removal should happen.
        expect(r.overlapInfo.overlapWords).toBe(0);
        expect(r.text).toContain("sat");
    });

    test("joins without loss when no overlap found", () => {
        const prev = "First sentence here.";
        const curr = "Completely different content.";
        const r = glueTranscripts(prev, curr);
        expect(r.text).toContain("First sentence here");
        expect(r.text).toContain("Completely different content");
    });
});

// ---------------------------------------------------------------------------
// glueTranscripts – multilingual
// ---------------------------------------------------------------------------

describe("glueTranscripts – multilingual", () => {
    test("stitches Japanese text with overlap", () => {
        // Japanese "words" are space-delimited here, giving 3-word prev and 3-word curr
        const prev = "今日は晴れです 明日も晴れます 空が青い";
        const curr = "明日も晴れます 空が青い それは素晴らしい";
        const r = glueTranscripts(prev, curr);
        expect(r.overlapInfo.overlapWords).toBeGreaterThanOrEqual(2);
        expect(r.text).toContain("素晴らしい");
    });

    test("stitches Arabic text with overlap", () => {
        const prev = "مرحبا بالعالم يا صديقي";
        const curr = "يا صديقي كيف حالك";
        const r = glueTranscripts(prev, curr);
        expect(r.overlapInfo.overlapWords).toBeGreaterThanOrEqual(2);
        expect(r.text).toContain("كيف حالك");
    });

    test("handles mixed-language text", () => {
        const prev = "Hello world こんにちは world";
        const curr = "こんにちは world how are you";
        const r = glueTranscripts(prev, curr);
        expect(r.overlapInfo.overlapWords).toBeGreaterThanOrEqual(2);
        expect(r.text).toContain("how are you");
    });
});

// ---------------------------------------------------------------------------
// glueTranscripts – near-empty chunks
// ---------------------------------------------------------------------------

describe("glueTranscripts – near-empty chunks", () => {
    test("single-word previous text joined safely", () => {
        const r = glueTranscripts("Hi", "Hi there friend");
        expect(r.text).toContain("Hi");
        expect(r.text).toContain("there friend");
    });

    test("single-word current text appended safely", () => {
        const r = glueTranscripts("The quick brown fox", "fox");
        // "fox" alone is a 1-word match – below threshold – so it's kept
        expect(r.text).toContain("fox");
    });

    test("returns stable result for repeated equal chunks", () => {
        const text = "hello world hello world";
        const r = glueTranscripts(text, text);
        // Some overlap will be found; result should not be empty
        expect(r.text.trim().length).toBeGreaterThan(0);
    });
});
