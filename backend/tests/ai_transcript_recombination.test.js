/**
 * Unit tests for the ai/transcript_recombination module.
 */

jest.mock("openai", () => ({
    OpenAI: jest.fn(),
}));

const { OpenAI } = require("openai");
const {
    RECOMBINATION_MODEL,
    MAX_RETRY_ATTEMPTS,
    SYSTEM_PROMPT,
    isAITranscriptRecombinationError,
    make,
    makeUserPrompt,
    makeWordSet,
    validateWordSubset,
    programmaticRecombination,
    validateCombination,
} = require("../src/ai/transcript_recombination");

function makeMockCapabilities() {
    return {
        environment: {
            openaiAPIKey: jest.fn().mockReturnValue("test-api-key"),
        },
    };
}

function setupMockClient(responseText) {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [
            {
                message: {
                    content: responseText,
                },
            },
        ],
    });

    OpenAI.mockImplementation(() => ({
        chat: {
            completions: {
                create: mockCreate,
            },
        },
    }));

    return { mockCreate };
}

// ─── makeWordSet ──────────────────────────────────────────────────────────────

describe("makeWordSet", () => {
    it("returns a set of lowercase words", () => {
        const result = makeWordSet("Hello, World!");
        expect(result.has("hello")).toBe(true);
        expect(result.has("world")).toBe(true);
    });

    it("ignores empty strings", () => {
        const result = makeWordSet("  ");
        expect(result.size).toBe(0);
    });

    it("strips surrounding punctuation but preserves internal apostrophes", () => {
        const result = makeWordSet("it's fine.");
        expect(result.has("it's")).toBe(true);
        expect(result.has("fine")).toBe(true);
    });

    it("preserves internal hyphens in hyphenated words", () => {
        const result = makeWordSet("twenty-one");
        expect(result.has("twenty-one")).toBe(true);
    });

    it("strips leading and trailing hyphens", () => {
        const result = makeWordSet("-word-");
        expect(result.has("word")).toBe(true);
    });
});

// ─── validateWordSubset ───────────────────────────────────────────────────────

describe("validateWordSubset", () => {
    it("returns true when all output words are in allowed set", () => {
        const allowed = makeWordSet("I walked to the store");
        expect(validateWordSubset("walked to the store", allowed)).toBe(true);
    });

    it("returns false when output contains a word not in allowed set", () => {
        const allowed = makeWordSet("I walked to the store");
        expect(validateWordSubset("I drove to the store", allowed)).toBe(false);
    });

    it("returns true for empty output", () => {
        const allowed = makeWordSet("some words here");
        expect(validateWordSubset("", allowed)).toBe(true);
    });

    it("is case-insensitive", () => {
        const allowed = makeWordSet("Hello World");
        expect(validateWordSubset("hello world", allowed)).toBe(true);
    });
});

// ─── programmaticRecombination ───────────────────────────────────────────────

describe("programmaticRecombination", () => {
    it("deduplicates when the last words of segment1 match first words of segment2", () => {
        // overlap: ["walked","to"]
        const result = programmaticRecombination("I walked to", "walked to the store");
        expect(result).toBe("I walked to the store");
    });

    it("deduplicates the longest overlap, not the first match found", () => {
        // overlap of length 3: "to the store"
        const result = programmaticRecombination("I walked to the store", "to the store and back");
        expect(result).toBe("I walked to the store and back");
    });

    it("keeps all of segment1 when segment2 starts right after", () => {
        // overlap of length 1: "world"
        const result = programmaticRecombination("hello world", "world of tomorrow");
        expect(result).toBe("hello world of tomorrow");
    });

    it("is case-insensitive in overlap detection", () => {
        const result = programmaticRecombination("Hello World", "hello world there");
        expect(result).toBe("Hello World there");
    });

    it("is punctuation-insensitive in overlap detection", () => {
        // "hello," normalises to "hello", matches "hello" in segment2
        const result = programmaticRecombination("hello,", "hello there");
        expect(result).toBe("hello, there");
    });

    it("returns segment2 when segment1 is entirely the overlap", () => {
        // "walked to the" is entirely the overlap with the start of segment2
        const result = programmaticRecombination("walked to the", "walked to the store");
        expect(result).toBe("walked to the store");
    });

    it("falls back to [10-second overlap] marker when no overlap found", () => {
        const result = programmaticRecombination("first part", "second part");
        expect(result).toBe("first part [10-second overlap] second part");
    });

    it("falls back to [10-second overlap] marker for completely unrelated segments", () => {
        const result = programmaticRecombination("hello", "world");
        expect(result).toBe("hello [10-second overlap] world");
    });

    it("returns segment2 when segment1 is empty", () => {
        const result = programmaticRecombination("", "second part");
        expect(result).toBe("second part");
    });

    it("returns segment2 when segment1 is whitespace only", () => {
        const result = programmaticRecombination("   ", "second part");
        expect(result).toBe("second part");
    });

    it("returns segment1 when segment2 is empty", () => {
        const result = programmaticRecombination("first part", "");
        expect(result).toBe("first part");
    });

    it("returns segment1 when segment2 is whitespace only", () => {
        const result = programmaticRecombination("first part", "  ");
        expect(result).toBe("first part");
    });

    it("does not match on pure-punctuation tokens", () => {
        // "." normalises to "", so it should not be used as an overlap match
        const result = programmaticRecombination("end.", ". start");
        expect(result).toBe("end. [10-second overlap] . start");
    });

    it("includes the literal [10-second overlap] marker when no overlap", () => {
        const result = programmaticRecombination("a", "b");
        expect(result).toContain("[10-second overlap]");
    });

    it("handles hyphenated words in overlap detection", () => {
        const result = programmaticRecombination("twenty-one steps", "twenty-one steps ahead");
        expect(result).toBe("twenty-one steps ahead");
    });

    it("handles contractions in overlap detection", () => {
        const result = programmaticRecombination("it's fine", "it's fine now");
        expect(result).toBe("it's fine now");
    });
});

// ─── validateCombination ──────────────────────────────────────────────────────

describe("validateCombination", () => {
    it("returns true when result equals prefix(seg1) + full suffix of seg2", () => {
        // split=1: prefix="I", suffix="walked to the store" = seg2
        expect(validateCombination("I walked to the store", "I walked to", "walked to the store")).toBe(true);
    });

    it("returns true when result equals full seg1 + suffix of seg2", () => {
        // split=3: prefix="I walked to"=full seg1, suffix="and back"
        expect(validateCombination("I walked to and back", "I walked to", "walked to and back")).toBe(true);
    });

    it("returns true when result equals full seg2 (empty prefix of seg1)", () => {
        // split=0: empty prefix, suffix=result = seg2
        expect(validateCombination("walked to the store", "I walked to", "walked to the store")).toBe(true);
    });

    it("returns true when result equals full seg1 (empty suffix of seg2)", () => {
        // seg2 has words, suffix can be empty only if len(result)=len(words1) and result == words1
        // Actually suffix.length=0 means offset=len(words2), every() vacuously true
        expect(validateCombination("I walked to", "I walked to", "walked to the store")).toBe(true);
    });

    it("returns false when result contains a hallucinated word", () => {
        expect(validateCombination("I drove to the store", "I walked to", "walked to the store")).toBe(false);
    });

    it("returns false when result words are rearranged", () => {
        expect(validateCombination("to I walked the store", "I walked to", "walked to the store")).toBe(false);
    });

    it("returns false when result is a mix not matching prefix+suffix structure", () => {
        // "walked" is in seg2 but is not a valid prefix of seg1 ("I walked to")
        expect(validateCombination("walked I the store", "I walked to", "walked to the store")).toBe(false);
    });

    it("returns true when result equals seg1 + full seg2 (no overlap removed)", () => {
        // seg1="existing", seg2="new content"
        // split=1: prefix="existing"=words1, suffix="new content"=full words2
        expect(validateCombination("existing new content", "existing", "new content")).toBe(true);
    });

    it("is case-insensitive in comparison", () => {
        expect(validateCombination("I Walked To The Store", "I walked to", "walked to the store")).toBe(true);
    });

    it("is punctuation-insensitive in comparison", () => {
        expect(validateCombination("I walked to, the store.", "I walked to", "walked to the store")).toBe(true);
    });

    it("returns false for empty inputs that produce no valid split", () => {
        // result has words but seg1 and seg2 are both empty → no valid split
        expect(validateCombination("something", "", "")).toBe(false);
    });

    it("returns true for empty result (vacuously a valid combination)", () => {
        // empty result: split=0, empty suffix matches any suffix of words2
        expect(validateCombination("", "seg1", "seg2")).toBe(true);
    });

    it("returns false when result is longer than combined inputs allow", () => {
        // "a b c d e" cannot be prefix(["a","b"]) + suffix(["c","d"]) as that has max 4 words
        expect(validateCombination("a b c d e", "a b", "c d")).toBe(false);
    });
});

// ─── makeUserPrompt ───────────────────────────────────────────────────────────

describe("makeUserPrompt", () => {
    it("includes both input segments in the prompt", () => {
        const prompt = makeUserPrompt("existing text", "new text");
        expect(prompt).toContain("existing text");
        expect(prompt).toContain("new text");
    });

    it("shows (empty) placeholder for empty existing text", () => {
        const prompt = makeUserPrompt("", "new text");
        expect(prompt).toContain("(empty)");
    });

    it("shows (empty) placeholder for empty new text", () => {
        const prompt = makeUserPrompt("existing text", "");
        expect(prompt).toContain("(empty)");
    });
});

// ─── make / recombineOverlap ──────────────────────────────────────────────────

describe("recombineOverlap", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("calls the model with the correct inputs and returns recombined text", async () => {
        const { mockCreate } = setupMockClient("I walked to the store");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("I walked to", "walked to the store");

        expect(result).toBe("I walked to the store");
        expect(OpenAI).toHaveBeenCalledWith({ apiKey: "test-api-key" });
        expect(mockCreate).toHaveBeenCalledWith({
            model: RECOMBINATION_MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: makeUserPrompt("I walked to", "walked to the store") },
            ],
        });
    });

    it("falls back to programmatic recombination (not throw) when model returns invalid combination", async () => {
        // LLM returns words not in either input → validateCombination fails
        // programmaticRecombination("I walked to", "walked to the store")
        //   finds overlap ["walked","to"] → "I walked to the store"
        setupMockClient("I drove to the park");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("I walked to", "walked to the store");

        expect(result).toBe("I walked to the store");
    });

    it("falls back to programmatic recombination when model returns empty response", async () => {
        // programmaticRecombination("hello", "hello world") → overlap ["hello"] → "hello world"
        setupMockClient("");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("hello", "hello world");

        expect(result).toBe("hello world");
    });

    it("falls back to programmatic recombination when API call fails", async () => {
        // programmaticRecombination("hello", "hello world") → overlap ["hello"] → "hello world"
        OpenAI.mockImplementation(() => ({
            chat: {
                completions: {
                    create: jest.fn().mockRejectedValue(new Error("network error")),
                },
            },
        }));
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("hello", "hello world");

        expect(result).toBe("hello world");
    });

    it("rejects LLM output that is a proper subset of input words (not a valid prefix+suffix combination)", async () => {
        // "walked store" is neither prefix("I walked to the") nor suffix("walked to the store")
        // so it fails validateCombination.
        // programmaticRecombination("I walked to the", "walked to the store")
        //   finds overlap ["walked","to","the"] → "I walked to the store"
        setupMockClient("walked store");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("I walked to the", "walked to the store");
        expect(result).toBe("I walked to the store");
    });

    it("uses the mini model constant", () => {
        expect(RECOMBINATION_MODEL).toBe("gpt-4o-mini");
    });

    it("retries exactly MAX_RETRY_ATTEMPTS times before falling back", async () => {
        const mockCreate = jest.fn().mockRejectedValue(new Error("API error"));
        OpenAI.mockImplementation(() => ({
            chat: { completions: { create: mockCreate } },
        }));
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing", "new content");

        expect(mockCreate).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
        expect(result).toBe("existing [10-second overlap] new content");
    });

    it("succeeds on second attempt after one failure", async () => {
        const mockCreate = jest
            .fn()
            .mockRejectedValueOnce(new Error("transient error"))
            .mockResolvedValue({
                choices: [{ message: { content: "existing new content" } }],
            });
        OpenAI.mockImplementation(() => ({
            chat: { completions: { create: mockCreate } },
        }));
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing", "new content");

        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result).toBe("existing new content");
    });

    it("succeeds on the last of MAX_RETRY_ATTEMPTS attempts", async () => {
        const mockCreate = jest.fn();
        // Fail all but the last attempt
        for (let i = 0; i < MAX_RETRY_ATTEMPTS - 1; i++) {
            mockCreate.mockRejectedValueOnce(new Error("transient error"));
        }
        mockCreate.mockResolvedValue({
            choices: [{ message: { content: "existing new content" } }],
        });
        OpenAI.mockImplementation(() => ({
            chat: { completions: { create: mockCreate } },
        }));
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing", "new content");

        expect(mockCreate).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
        expect(result).toBe("existing new content");
    });

    it("retries when validation fails and falls back after MAX_RETRY_ATTEMPTS", async () => {
        // Always return a word not in the inputs
        const { mockCreate } = setupMockClient("invented fabricated word");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing", "new content");

        expect(mockCreate).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
        expect(result).toBe("existing [10-second overlap] new content");
    });

    it("calls LLM for the full input and falls back to programmatic when output fails validation", async () => {
        const words = Array.from({ length: 65 }, (_, i) => `word${i}`);
        const newWindowText = words.join(" ");

        // LLM returns only the first 60 words — validateCombination will reject this
        // (the suffix of newWindowText is not matched), causing retries then fallback.
        const { mockCreate } = setupMockClient(words.slice(0, 60).join(" "));
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        await ai.recombineOverlap("overlap", newWindowText);
        expect(mockCreate).toHaveBeenCalled();
    });

    it("returns LLM result for a long two-segment input (no splitting, single LLM call)", async () => {
        const segment1 = Array.from({ length: 60 }, (_, i) => `a${i}`).join(" ");
        const segment2 = Array.from({ length: 60 }, (_, i) => `b${i}`).join(" ");
        const newWindowText = `${segment1} ${segment2}`;

        // The LLM receives the full newWindowText. validateCombination must accept the result.
        // Use segment1 as existing and newWindowText as new; return newWindowText as result
        // so that split=0 (empty prefix, suffix=newWindowText) is valid.
        const { mockCreate } = setupMockClient(newWindowText);
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing", newWindowText);

        // LLM called once with the full newWindowText (no splitting).
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(result).toBe(newWindowText);
    });

    it("returns programmatic recombination for empty existingOverlapText", async () => {
        setupMockClient("");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("", "hello world");
        expect(result).toBe("hello world");
    });

    it("returns programmatic recombination for empty newWindowText", async () => {
        setupMockClient("");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing text", "");
        expect(result).toBe("existing text");
    });
});

// ─── isAITranscriptRecombinationError ────────────────────────────────────────

describe("isAITranscriptRecombinationError", () => {
    it("returns false for a regular Error", () => {
        expect(isAITranscriptRecombinationError(new Error("regular"))).toBe(false);
    });

    it("returns false for non-Error values", () => {
        expect(isAITranscriptRecombinationError(null)).toBe(false);
        expect(isAITranscriptRecombinationError("string")).toBe(false);
        expect(isAITranscriptRecombinationError(42)).toBe(false);
    });
});
