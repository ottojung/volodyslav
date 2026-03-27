/**
 * Unit tests for the ai/transcript_recombination module.
 */

jest.mock("openai", () => ({
    OpenAI: jest.fn(),
}));

const { OpenAI } = require("openai");
const {
    RECOMBINATION_MODEL,
    SYSTEM_PROMPT,
    isAITranscriptRecombinationError,
    make,
    makeUserPrompt,
    makeWordSet,
    validateWordSubset,
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

    it("throws AITranscriptRecombinationError when model returns a word not in inputs", async () => {
        setupMockClient("I drove to the park");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const error = await ai
            .recombineOverlap("I walked to", "walked to the store")
            .catch((e) => e);

        expect(isAITranscriptRecombinationError(error)).toBe(true);
        expect(error.message).toMatch(/not found in original inputs/i);
    });

    it("throws AITranscriptRecombinationError when model returns empty response", async () => {
        setupMockClient("");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const error = await ai
            .recombineOverlap("hello", "hello world")
            .catch((e) => e);

        expect(isAITranscriptRecombinationError(error)).toBe(true);
        expect(error.message).toMatch(/empty response/i);
    });

    it("throws AITranscriptRecombinationError when API call fails", async () => {
        OpenAI.mockImplementation(() => ({
            chat: {
                completions: {
                    create: jest.fn().mockRejectedValue(new Error("network error")),
                },
            },
        }));
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const error = await ai
            .recombineOverlap("hello", "hello world")
            .catch((e) => e);

        expect(isAITranscriptRecombinationError(error)).toBe(true);
        expect(error.message).toMatch(/network error/i);
    });

    it("accepts output that is a proper subset of input words", async () => {
        setupMockClient("walked store");
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);

        const result = await ai.recombineOverlap("I walked to the", "walked to the store");
        expect(result).toBe("walked store");
    });
});

// ─── isAITranscriptRecombinationError ────────────────────────────────────────

describe("isAITranscriptRecombinationError", () => {
    it("returns true for an AITranscriptRecombinationError", async () => {
        OpenAI.mockImplementation(() => ({
            chat: {
                completions: {
                    create: jest.fn().mockRejectedValue(new Error("oops")),
                },
            },
        }));
        const capabilities = makeMockCapabilities();
        const ai = make(() => capabilities);
        const err = await ai.recombineOverlap("a", "b").catch((e) => e);
        expect(isAITranscriptRecombinationError(err)).toBe(true);
    });

    it("returns false for a regular Error", () => {
        expect(isAITranscriptRecombinationError(new Error("regular"))).toBe(false);
    });

    it("returns false for non-Error values", () => {
        expect(isAITranscriptRecombinationError(null)).toBe(false);
        expect(isAITranscriptRecombinationError("string")).toBe(false);
        expect(isAITranscriptRecombinationError(42)).toBe(false);
    });
});
