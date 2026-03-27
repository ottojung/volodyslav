/**
 * Unit tests for the ai/transcript_recombination module.
 */

jest.mock("openai", () => ({
    OpenAI: jest.fn(),
}));

const { OpenAI } = require("openai");
const {
    RECOMBINATION_MODEL,
    FRAGMENT_MAX_WORDS,
    MAX_RETRY_ATTEMPTS,
    SYSTEM_PROMPT,
    isAITranscriptRecombinationError,
    make,
    makeUserPrompt,
    makeWordSet,
    validateWordSubset,
    splitIntoFragments,
    simplisticRecombination,
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

// ─── splitIntoFragments ──────────────────────────────────────────────────────

describe("splitIntoFragments", () => {
    it("returns a single fragment when text is shorter than maxWords", () => {
        const result = splitIntoFragments("hello world", 10);
        expect(result).toEqual(["hello world"]);
    });

    it("returns exactly one element for empty string", () => {
        const result = splitIntoFragments("");
        expect(result).toEqual([""]);
    });

    it("returns exactly one element for whitespace-only string", () => {
        const result = splitIntoFragments("   ");
        expect(result).toEqual([""]);
    });

    it("splits text into two fragments when words exceed maxWords", () => {
        const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
        const result = splitIntoFragments(words.join(" "), 6);
        expect(result).toHaveLength(2);
        expect(result[0]).toBe(words.slice(0, 6).join(" "));
        expect(result[1]).toBe(words.slice(6).join(" "));
    });

    it("splits text into three fragments when words are triple maxWords", () => {
        const words = Array.from({ length: 9 }, (_, i) => `w${i}`);
        const result = splitIntoFragments(words.join(" "), 3);
        expect(result).toHaveLength(3);
        expect(result[0]).toBe("w0 w1 w2");
        expect(result[1]).toBe("w3 w4 w5");
        expect(result[2]).toBe("w6 w7 w8");
    });

    it("respects FRAGMENT_MAX_WORDS as default maxWords", () => {
        const words = Array.from({ length: FRAGMENT_MAX_WORDS + 1 }, (_, i) => `w${i}`);
        const result = splitIntoFragments(words.join(" "));
        expect(result).toHaveLength(2);
        expect(result[0]?.split(" ")).toHaveLength(FRAGMENT_MAX_WORDS);
        expect(result[1]?.split(" ")).toHaveLength(1);
    });

    it("returns a single fragment for text exactly at maxWords limit", () => {
        const words = Array.from({ length: 5 }, (_, i) => `w${i}`);
        const result = splitIntoFragments(words.join(" "), 5);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(words.join(" "));
    });

    it("handles single-word text", () => {
        const result = splitIntoFragments("hello", 10);
        expect(result).toEqual(["hello"]);
    });

    it("trims leading/trailing whitespace before splitting", () => {
        const result = splitIntoFragments("  hello world  ", 10);
        expect(result).toEqual(["hello world"]);
    });
});

// ─── simplisticRecombination ──────────────────────────────────────────────────

describe("simplisticRecombination", () => {
    it("returns both texts joined with the [10-second overlap] marker", () => {
        const result = simplisticRecombination("first part", "second part");
        expect(result).toBe("first part [10-second overlap] second part");
    });

    it("returns newText when existingText is empty", () => {
        const result = simplisticRecombination("", "second part");
        expect(result).toBe("second part");
    });

    it("returns newText when existingText is whitespace only", () => {
        const result = simplisticRecombination("   ", "second part");
        expect(result).toBe("second part");
    });

    it("returns existingText when newText is empty", () => {
        const result = simplisticRecombination("first part", "");
        expect(result).toBe("first part");
    });

    it("returns existingText when newText is whitespace only", () => {
        const result = simplisticRecombination("first part", "  ");
        expect(result).toBe("first part");
    });

    it("includes the literal [10-second overlap] bracket marker", () => {
        const result = simplisticRecombination("a", "b");
        expect(result).toContain("[10-second overlap]");
    });
});

// ─── constants ───────────────────────────────────────────────────────────────

describe("constants", () => {
    it("RECOMBINATION_MODEL is a mini model", () => {
        expect(RECOMBINATION_MODEL).toBe("gpt-4o-mini");
    });

    it("FRAGMENT_MAX_WORDS equals 20 seconds * 3 words/second = 60", () => {
        expect(FRAGMENT_MAX_WORDS).toBe(60);
    });

    it("MAX_RETRY_ATTEMPTS is 5", () => {
        expect(MAX_RETRY_ATTEMPTS).toBe(5);
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

    it("falls back to simplistic recombination (not throw) when model returns a word not in inputs", async () => {
        setupMockClient("I drove to the park");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("I walked to", "walked to the store");

        expect(result).toBe("I walked to [10-second overlap] walked to the store");
    });

    it("falls back to simplistic recombination when model returns empty response", async () => {
        setupMockClient("");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("hello", "hello world");

        expect(result).toBe("hello [10-second overlap] hello world");
    });

    it("falls back to simplistic recombination when API call fails", async () => {
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

        expect(result).toBe("hello [10-second overlap] hello world");
    });

    it("accepts output that is a proper subset of input words", async () => {
        setupMockClient("walked store");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("I walked to the", "walked to the store");
        expect(result).toBe("walked store");
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

    it("appends second fragment programmatically without calling LLM", async () => {
        // Build a newWindowText that exceeds FRAGMENT_MAX_WORDS
        const firstFragment = Array.from({ length: FRAGMENT_MAX_WORDS }, (_, i) => `w${i}`).join(" ");
        const secondFragment = "extra words here";
        const newWindowText = `${firstFragment} ${secondFragment}`;

        const { mockCreate } = setupMockClient(firstFragment);
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing overlap", newWindowText);

        // LLM should only be called once (for the first fragment)
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(result).toContain(secondFragment);
    });

    it("calls LLM only for first fragment when input exceeds FRAGMENT_MAX_WORDS", async () => {
        const words = Array.from({ length: FRAGMENT_MAX_WORDS + 5 }, (_, i) => `word${i}`);
        const newWindowText = words.join(" ");
        const firstFragmentWords = words.slice(0, FRAGMENT_MAX_WORDS).join(" ");

        const { mockCreate } = setupMockClient(firstFragmentWords);
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        await ai.recombineOverlap("overlap", newWindowText);

        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        content: makeUserPrompt("overlap", firstFragmentWords),
                    }),
                ]),
            })
        );
    });

    it("returns both fragments joined when input is exactly two fragments long", async () => {
        const fragment1 = Array.from({ length: FRAGMENT_MAX_WORDS }, (_, i) => `a${i}`).join(" ");
        const fragment2 = Array.from({ length: FRAGMENT_MAX_WORDS }, (_, i) => `b${i}`).join(" ");
        const newWindowText = `${fragment1} ${fragment2}`;

        const { mockCreate } = setupMockClient(fragment1);
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("existing", newWindowText);

        // LLM only called once
        expect(mockCreate).toHaveBeenCalledTimes(1);
        // Result contains both fragments
        expect(result).toBe(`${fragment1} ${fragment2}`);
    });

    it("returns simplistic recombination for empty existingOverlapText", async () => {
        setupMockClient("");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("", "hello world");
        expect(result).toBe("hello world");
    });

    it("returns simplistic recombination for empty newWindowText", async () => {
        // splitIntoFragments("") returns [""] so the LLM will be called with empty
        // new fragment; the LLM returns empty → fallback is simplisticRecombination("existing", "")
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
