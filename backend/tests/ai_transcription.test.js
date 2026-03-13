/**
 * Unit tests for the ai/transcription module.
 *
 * These tests mock @google/genai and verify:
 *  - request construction (model, config, prompt, schema)
 *  - response validation (valid/invalid JSON, missing fields, partial coverage, MAX_TOKENS, no candidates)
 *  - metadata preservation (usageMetadata, modelVersion, responseId, tokenCount, finishMessage)
 *  - file cleanup (on success, on failure, delete failure handling)
 *  - transcribeStream compatibility (returns Promise<string>)
 */

/* eslint jest/expect-expect: ["error", { "assertFunctionNames": ["expect", "expectAITranscriptionError"] }] */

jest.mock("@google/genai", () => {
    const actual = jest.requireActual("@google/genai");
    return {
        ...actual,
        GoogleGenAI: jest.fn(),
    };
});

const { GoogleGenAI } = require("@google/genai");
const {
    make,
    isAITranscriptionError,
    TRANSCRIBER_MODEL,
    MAX_OUTPUT_TOKENS,
    TEMPERATURE,
    THINKING_LEVEL,
    TRANSCRIPTION_PROMPT,
    RESPONSE_SCHEMA,
} = require("../src/ai/transcription");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockCapabilities() {
    return {
        environment: {
            geminiApiKey: jest.fn().mockReturnValue("test-api-key"),
        },
        sleeper: {
            sleep: jest.fn().mockResolvedValue(undefined),
        },
        logger: {
            logWarning: jest.fn(),
            logError: jest.fn(),
            logInfo: jest.fn(),
            logDebug: jest.fn(),
        },
    };
}

function makeFileStream(filePath = "/tmp/test.mp3") {
    return { path: filePath };
}

function makeValidStructuredJson(overrides = {}) {
    return JSON.stringify({
        transcript: "Hello world",
        coverage: "full",
        warnings: [],
        unclearAudio: false,
        ...overrides,
    });
}

function makeValidGeminiResponse(overrides = {}) {
    const structured = overrides.structuredJson ?? makeValidStructuredJson();
    const candidateOverride = overrides.candidate ?? {};
    const responseOverride = overrides.response ?? {};
    return {
        candidates: [
            {
                content: { parts: [{ text: structured }] },
                finishReason: "STOP",
                finishMessage: null,
                tokenCount: 100,
                ...candidateOverride,
            },
        ],
        text: structured,
        usageMetadata: {
            totalTokenCount: 200,
            promptTokenCount: 100,
            candidatesTokenCount: 100,
        },
        modelVersion: "gemini-3-flash-preview-0512",
        responseId: "test-response-id-abc",
        ...responseOverride,
    };
}

function makeUploadedFile(overrides = {}) {
    return {
        uri: "https://generativelanguage.googleapis.com/v1beta/files/test-file-id",
        mimeType: "audio/mpeg",
        name: "files/test-file-id",
        state: "ACTIVE",
        ...overrides,
    };
}

function setupMockClient(uploadResult, generateResult) {
    const mockUpload = jest.fn().mockResolvedValue(uploadResult);
    const mockGet = jest.fn().mockResolvedValue(uploadResult);
    const mockGenerateContent = jest.fn().mockResolvedValue(generateResult);
    const mockDelete = jest.fn().mockResolvedValue({});

    GoogleGenAI.mockImplementation(() => ({
        files: {
            upload: mockUpload,
            get: mockGet,
            delete: mockDelete,
        },
        models: {
            generateContent: mockGenerateContent,
        },
    }));

    return { mockUpload, mockGet, mockGenerateContent, mockDelete };
}

/**
 * Awaits a promise and asserts it rejects with an AITranscriptionError.
 * Returns the caught error so callers can make further assertions.
 * @param {Promise<unknown>} promise
 * @returns {Promise<Error>}
 */
async function expectAITranscriptionError(promise) {
    const err = await promise.catch((e) => e);
    expect(isAITranscriptionError(err)).toBe(true);
    return err;
}

// ---------------------------------------------------------------------------
// Request construction tests
// ---------------------------------------------------------------------------

describe("transcribeStreamDetailed: request construction", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("uses the correct model name", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.model).toBe(TRANSCRIBER_MODEL);
    });

    test("sets maxOutputTokens to 65536", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
        expect(MAX_OUTPUT_TOKENS).toBe(65536);
    });

    test("sets temperature to a low value (0.0)", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config.temperature).toBe(TEMPERATURE);
        expect(TEMPERATURE).toBe(0.0);
    });

    test("sets thinkingLevel to 'low'", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config.thinkingConfig).toBeDefined();
        expect(call.config.thinkingConfig.thinkingLevel).toBe(THINKING_LEVEL);
        expect(THINKING_LEVEL).toBe("LOW");
    });

    test("sets responseMimeType to 'application/json'", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config.responseMimeType).toBe("application/json");
    });

    test("passes the response schema", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config.responseSchema).toEqual(RESPONSE_SCHEMA);
        expect(RESPONSE_SCHEMA.required).toContain("transcript");
        expect(RESPONSE_SCHEMA.required).toContain("coverage");
        expect(RESPONSE_SCHEMA.required).toContain("warnings");
        expect(RESPONSE_SCHEMA.required).toContain("unclearAudio");
    });

    test("sends the strict transcription prompt text", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        // Verify generateContent was called
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        const call = mockGenerateContent.mock.calls[0][0];
        // Ensure the strict transcription prompt is actually wired into the request payload
        expect(call.contents.parts).toContainEqual(
            expect.objectContaining({ text: TRANSCRIPTION_PROMPT })
        );
        // The prompt constant must forbid paraphrasing and require verbatim transcript
        expect(TRANSCRIPTION_PROMPT).toMatch(/verbatim/i);
        expect(TRANSCRIPTION_PROMPT).toMatch(/paraphrase/i);
        expect(TRANSCRIPTION_PROMPT).toMatch(/transcript/i);
        expect(TRANSCRIPTION_PROMPT).toMatch(/translate/i);
        expect(TRANSCRIPTION_PROMPT).toMatch(/do not/i);
    });

    test("uploads the file from the stream path", async () => {
        const { mockUpload } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream("/tmp/audio.mp3"));

        expect(mockUpload).toHaveBeenCalledTimes(1);
        const uploadCall = mockUpload.mock.calls[0][0];
        expect(uploadCall.file).toBe("/tmp/audio.mp3");
        expect(uploadCall.config.mimeType).toBe("audio/mpeg");
    });

    test("infers correct mime type for .wav files", async () => {
        const { mockUpload } = setupMockClient(
            makeUploadedFile({ mimeType: "audio/wav" }),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream("/tmp/audio.wav"));

        const uploadCall = mockUpload.mock.calls[0][0];
        expect(uploadCall.config.mimeType).toBe("audio/wav");
    });

    test("throws AITranscriptionError for unsupported file extension", async () => {
        setupMockClient(makeUploadedFile(), makeValidGeminiResponse());

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const err = await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream("/tmp/audio.unknown")));

        expect(err.message).toMatch(/Unsupported audio file extension/);
    });
});

// ---------------------------------------------------------------------------
// Response parsing and validation tests
// ---------------------------------------------------------------------------

describe("transcribeStreamDetailed: response validation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("returns normalized result for a valid structured JSON response", async () => {
        setupMockClient(makeUploadedFile(), makeValidGeminiResponse());

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.text).toBe("Hello world");
        expect(result.provider).toBe("Google");
        expect(result.model).toBe(TRANSCRIBER_MODEL);
        expect(result.structured.transcript).toBe("Hello world");
        expect(result.structured.coverage).toBe("full");
        expect(result.structured.warnings).toEqual([]);
        expect(result.structured.unclearAudio).toBe(false);
    });

    test("throws AITranscriptionError when response text is not valid JSON", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ structuredJson: "not-json{{{" })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("throws AITranscriptionError when transcript field is missing from JSON", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: JSON.stringify({ coverage: "full", warnings: [], unclearAudio: false }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("does not throw AITranscriptionError when coverage is 'partial'", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: makeValidStructuredJson({ coverage: "partial" }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expect(ai.transcribeStreamDetailed(makeFileStream())).resolves.not.toThrow();
    });

    test("throws AITranscriptionError when finishReason is MAX_TOKENS", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                candidate: { finishReason: "MAX_TOKENS", finishMessage: "output limit reached" },
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const err = await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
        expect(err.message).toMatch(/MAX_TOKENS/);
    });

    test("MAX_TOKENS error message includes finishMessage when available", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                candidate: {
                    finishReason: "MAX_TOKENS",
                    finishMessage: "Token limit exceeded",
                },
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const err = await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
        expect(err.message).toMatch(/Token limit exceeded/);
    });

    test("throws AITranscriptionError when candidates array is empty", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ response: { candidates: [] } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("throws AITranscriptionError when candidates is missing", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ response: { candidates: undefined } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("throws AITranscriptionError when uploaded file has no URI", async () => {
        setupMockClient(
            makeUploadedFile({ uri: undefined }),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("throws AITranscriptionError when uploaded file has no MIME type", async () => {
        setupMockClient(
            makeUploadedFile({ mimeType: undefined }),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("throws AITranscriptionError when candidate has no content", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                candidate: { content: undefined, finishReason: "STOP", tokenCount: 10 },
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("throws AITranscriptionError when generateContent itself throws", async () => {
        const mockUpload = jest.fn().mockResolvedValue(makeUploadedFile());
        const mockGenerateContent = jest.fn().mockRejectedValue(new Error("network error"));
        const mockDelete = jest.fn().mockResolvedValue({});

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const err = await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
        expect(err.message).toMatch(/network error/);
    });

    test("normalizes missing warnings field to empty array", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: JSON.stringify({ transcript: "Hello", coverage: "full", unclearAudio: false }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.structured.warnings).toEqual([]);
    });

    test("normalizes non-array warnings field to empty array", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: JSON.stringify({ transcript: "Hello", coverage: "full", warnings: "not an array", unclearAudio: false }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.structured.warnings).toEqual([]);
    });

    test("normalizes missing unclearAudio field to false", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: JSON.stringify({ transcript: "Hello", coverage: "full", warnings: [] }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.structured.unclearAudio).toBe(false);
    });

    test("normalizes non-boolean unclearAudio field to false", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: JSON.stringify({ transcript: "Hello", coverage: "full", warnings: [], unclearAudio: "yes" }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.structured.unclearAudio).toBe(false);
    });

    test("preserves valid warnings array in structured result", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: JSON.stringify({
                    transcript: "Hello",
                    coverage: "full",
                    warnings: ["Some audio was low quality"],
                    unclearAudio: true,
                }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.structured.warnings).toEqual(["Some audio was low quality"]);
        expect(result.structured.unclearAudio).toBe(true);
    });
});

describe("transcribeStreamDetailed: upload/generation resilience", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("waits for uploaded file to become ACTIVE before generation", async () => {
        const uploadFile = makeUploadedFile({ state: "PROCESSING", name: "files/poll-me" });
        const activeFile = makeUploadedFile({ state: "ACTIVE", name: "files/poll-me" });
        const mockUpload = jest.fn().mockResolvedValue(uploadFile);
        const mockGet = jest
            .fn()
            .mockResolvedValueOnce(makeUploadedFile({ state: "PROCESSING", name: "files/poll-me" }))
            .mockResolvedValueOnce(activeFile);
        const mockGenerateContent = jest.fn().mockResolvedValue(makeValidGeminiResponse());
        const mockDelete = jest.fn().mockResolvedValue({});

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, get: mockGet, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    test("fails clearly when uploaded file reaches FAILED state", async () => {
        const uploadFile = makeUploadedFile({ state: "PROCESSING", name: "files/fail-me" });
        const mockUpload = jest.fn().mockResolvedValue(uploadFile);
        const mockGet = jest.fn().mockResolvedValue(makeUploadedFile({ state: "FAILED", name: "files/fail-me" }));
        const mockGenerateContent = jest.fn().mockResolvedValue(makeValidGeminiResponse());
        const mockDelete = jest.fn().mockResolvedValue({});

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, get: mockGet, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const err = await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));

        expect(err.message).toMatch(/File activation failed/);
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    test("retries transient upload failures with warning logs", async () => {
        const mockUpload = jest
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("UNAVAILABLE"), { status: 503, code: "UNAVAILABLE" }))
            .mockResolvedValue(makeUploadedFile());
        const mockGet = jest.fn().mockResolvedValue(makeUploadedFile());
        const mockGenerateContent = jest.fn().mockResolvedValue(makeValidGeminiResponse());
        const mockDelete = jest.fn().mockResolvedValue({});

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, get: mockGet, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        expect(mockUpload).toHaveBeenCalledTimes(2);
        expect(caps.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({ stage: "upload" }),
            expect.stringMatching(/retrying/)
        );
    });

    test("does not retry non-transient upload failures", async () => {
        const mockUpload = jest
            .fn()
            .mockRejectedValue(Object.assign(new Error("bad request"), { status: 400, code: "INVALID_ARGUMENT" }));
        const mockGet = jest.fn();
        const mockGenerateContent = jest.fn();
        const mockDelete = jest.fn();

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, get: mockGet, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));

        expect(mockUpload).toHaveBeenCalledTimes(1);
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    test("retries transient generation failures", async () => {
        const { mockUpload, mockGet } = setupMockClient(makeUploadedFile(), makeValidGeminiResponse());
        const mockGenerateContent = jest
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429, code: "RESOURCE_EXHAUSTED" }))
            .mockResolvedValue(makeValidGeminiResponse());
        const mockDelete = jest.fn().mockResolvedValue({});

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, get: mockGet, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.text).toBe("Hello world");
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// Metadata preservation tests
// ---------------------------------------------------------------------------

describe("transcribeStreamDetailed: metadata preservation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("preserves usageMetadata in result", async () => {
        const usageMetadata = {
            totalTokenCount: 500,
            promptTokenCount: 300,
            candidatesTokenCount: 200,
            thoughtsTokenCount: 50,
        };
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ response: { usageMetadata } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.usageMetadata).toEqual(usageMetadata);
        expect(result.usageMetadata.thoughtsTokenCount).toBe(50);
    });

    test("preserves modelVersion in result", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ response: { modelVersion: "gemini-3-flash-preview-0517" } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.modelVersion).toBe("gemini-3-flash-preview-0517");
    });

    test("preserves responseId in result", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ response: { responseId: "unique-response-id-xyz" } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.responseId).toBe("unique-response-id-xyz");
    });

    test("preserves candidate tokenCount in result", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ candidate: { tokenCount: 999 } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.candidateTokenCount).toBe(999);
    });

    test("preserves candidate finishMessage in result", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                candidate: { finishReason: "STOP", finishMessage: "completed normally" },
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.finishMessage).toBe("completed normally");
    });

    test("preserves finishReason in result", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ candidate: { finishReason: "STOP" } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.finishReason).toBe("STOP");
    });

    test("exposes rawResponse for debugging", async () => {
        const geminiResponse = makeValidGeminiResponse();
        setupMockClient(makeUploadedFile(), geminiResponse);

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.rawResponse).toBe(geminiResponse);
    });

    test("sets null for metadata fields that are absent in the response", async () => {
        const sparseResponse = {
            candidates: [
                {
                    content: { parts: [] },
                    finishReason: "STOP",
                },
            ],
            text: makeValidStructuredJson(),
        };
        setupMockClient(makeUploadedFile(), sparseResponse);

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.candidateTokenCount).toBeNull();
        expect(result.finishMessage).toBeNull();
        expect(result.usageMetadata).toBeNull();
        expect(result.modelVersion).toBeNull();
        expect(result.responseId).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// File cleanup tests
// ---------------------------------------------------------------------------

describe("transcribeStreamDetailed: file cleanup", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("deletes the uploaded file after a successful transcription", async () => {
        const { mockDelete } = setupMockClient(
            makeUploadedFile({ name: "files/abc123" }),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        expect(mockDelete).toHaveBeenCalledTimes(1);
        expect(mockDelete).toHaveBeenCalledWith({ name: "files/abc123" });
    });

    test("deletes the uploaded file even when generateContent throws", async () => {
        const mockUpload = jest.fn().mockResolvedValue(makeUploadedFile({ name: "files/cleanup-test" }));
        const mockGenerateContent = jest.fn().mockRejectedValue(new Error("API error"));
        const mockDelete = jest.fn().mockResolvedValue({});

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));

        expect(mockDelete).toHaveBeenCalledTimes(1);
        expect(mockDelete).toHaveBeenCalledWith({ name: "files/cleanup-test" });
    });

    test("deletes the uploaded file even when response validation fails", async () => {
        const { mockDelete } = setupMockClient(
            makeUploadedFile({ name: "files/validation-fail" }),
            makeValidGeminiResponse({
                candidate: { finishReason: "MAX_TOKENS" },
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));

        expect(mockDelete).toHaveBeenCalledTimes(1);
    });

    test("does not mask the primary error when file deletion fails", async () => {
        const mockUpload = jest.fn().mockResolvedValue(makeUploadedFile({ name: "files/delete-fail" }));
        const mockGenerateContent = jest.fn().mockRejectedValue(new Error("primary error"));
        const mockDelete = jest.fn().mockRejectedValue(new Error("delete error"));

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const err = await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));

        // Primary error must propagate, not the delete error
        expect(err.message).toMatch(/primary error/);
    });

    test("logs a warning when file deletion fails on a successful transcription", async () => {
        const mockUpload = jest.fn().mockResolvedValue(makeUploadedFile({ name: "files/log-warn" }));
        const mockGenerateContent = jest.fn().mockResolvedValue(makeValidGeminiResponse());
        const mockDelete = jest.fn().mockRejectedValue(new Error("quota exceeded"));

        GoogleGenAI.mockImplementation(() => ({
            files: { upload: mockUpload, delete: mockDelete },
            models: { generateContent: mockGenerateContent },
        }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        // Successful transcription but delete fails — should still return result
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.text).toBe("Hello world");
        expect(caps.logger.logWarning).toHaveBeenCalledTimes(1);
        expect(caps.logger.logWarning.mock.calls[0][1]).toMatch(/quota exceeded/);
    });

    test("skips deletion when the uploaded file has no name", async () => {
        const { mockDelete } = setupMockClient(
            makeUploadedFile({ name: undefined }),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        expect(mockDelete).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// transcribeStream compatibility tests
// ---------------------------------------------------------------------------

describe("transcribeStream: compatibility", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("returns a string (the transcript text) on success", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                structuredJson: makeValidStructuredJson({ transcript: "Hello from transcribeStream" }),
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStream(makeFileStream());

        expect(typeof result).toBe("string");
        expect(result).toBe("Hello from transcribeStream");
    });

    test("throws AITranscriptionError on invalid response instead of returning silently", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ candidate: { finishReason: "MAX_TOKENS" } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStream(makeFileStream()));
    });

    test("throws AITranscriptionError on MAX_TOKENS instead of returning truncated text", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({
                candidate: { finishReason: "MAX_TOKENS", finishMessage: null },
            })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStream(makeFileStream()));
    });

    test("getTranscriberInfo returns the model name and Google as creator", () => {
        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const info = ai.getTranscriberInfo();

        expect(info.name).toBe(TRANSCRIBER_MODEL);
        expect(info.creator).toBe("Google");
    });
});
