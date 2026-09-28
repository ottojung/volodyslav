/**
 * Unit tests for the ai/transcription module.
 *
 * These tests mock @google/genai and verify:
 *  - request construction (model, verbatim transcription mode, no prompt/schema/thinking)
 *  - response validation (plain-text transcript, MAX_TOKENS, no candidates)
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
jest.mock("openai", () => ({
    OpenAI: jest.fn(),
}));

const { GoogleGenAI } = require("@google/genai");
const { OpenAI } = require("openai");
const {
    make,
    isAITranscriptionError,
    TRANSCRIBER_MODEL,
    PRECISE_TRANSCRIBER_MODEL,
    TRANSCRIPTION_MODE,
} = require("../src/ai/transcription");
const { AudioTranscriptionConfigMode } = require("@google/genai");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockCapabilities() {
    return {
        environment: {
            geminiApiKey: jest.fn().mockReturnValue("test-api-key"),
            openaiAPIKey: jest.fn().mockReturnValue("test-openai-api-key"),
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

function setupMockOpenAIClient(resultOrError) {
    const createTranscription = jest.fn();
    if (resultOrError instanceof Error) {
        createTranscription.mockRejectedValue(resultOrError);
    } else {
        createTranscription.mockResolvedValue(resultOrError);
    }
    OpenAI.mockImplementation(() => ({
        audio: {
            transcriptions: {
                create: createTranscription,
            },
        },
    }));
    return { createTranscription };
}

function makeFileStream(filePath = "/tmp/test.mp3") {
    return { path: filePath };
}

const DEFAULT_TRANSCRIPT = "Hello world";

function makeValidGeminiResponse(overrides = {}) {
    const transcript = overrides.transcript ?? DEFAULT_TRANSCRIPT;
    const candidateOverride = overrides.candidate ?? {};
    const responseOverride = overrides.response ?? {};
    return {
        candidates: [
            {
                content: { parts: [{ text: transcript }] },
                finishReason: "STOP",
                finishMessage: null,
                tokenCount: 100,
                ...candidateOverride,
            },
        ],
        text: transcript,
        usageMetadata: {
            totalTokenCount: 200,
            promptTokenCount: 100,
            candidatesTokenCount: 100,
        },
        modelVersion: "gemini-3.5-transcribe",
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

    test("uses the dedicated transcription model name", async () => {
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
        expect(TRANSCRIBER_MODEL).toBe("gemini-3.5-transcribe");
    });

    test("requests verbatim transcription mode", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config.audioTranscriptionConfig.mode).toBe(TRANSCRIPTION_MODE);
        expect(TRANSCRIPTION_MODE).toBe("VERBATIM");
        expect(TRANSCRIPTION_MODE).toBe(AudioTranscriptionConfigMode.VERBATIM);
    });

    test("does not ask for smart transcription mode", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config.audioTranscriptionConfig.mode).not.toBe("SMART");
        expect(call.config.audioTranscriptionConfig.mode).not.toBe(
            AudioTranscriptionConfigMode.SMART
        );
    });

    test("omits language hints so multilingual and code-switched speech is preserved", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        // Automatic language detection preserves the spoken languages; an explicit
        // single language or vocabulary bias would coerce the transcript.
        expect(call.config.audioTranscriptionConfig.languageCodes).toBeUndefined();
        expect(call.config.audioTranscriptionConfig.languageHints).toBeUndefined();
        expect(call.config.audioTranscriptionConfig.customVocabulary).toBeUndefined();
    });

    test("sends no text prompt alongside the audio", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.contents.parts).toHaveLength(1);
        for (const part of call.contents.parts) {
            expect(part.text).toBeUndefined();
        }
    });

    test("sends no response schema, response mime type, thinking config, temperature, or output token limit", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        const call = mockGenerateContent.mock.calls[0][0];
        expect(call.config).toEqual({ audioTranscriptionConfig: { mode: TRANSCRIPTION_MODE } });
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

    test("returns the transcript as plain text for a valid response", async () => {
        setupMockClient(makeUploadedFile(), makeValidGeminiResponse());

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.text).toBe("Hello world");
        expect(result.provider).toBe("Google");
        expect(result.model).toBe(TRANSCRIBER_MODEL);
        expect(result.structured.transcript).toBe("Hello world");
    });

    test("returns code-switched and disfluent text unchanged", async () => {
        const codeSwitched = "Я кажу hello, це... um, значить, que todo bien, да?";
        setupMockClient(makeUploadedFile(), makeValidGeminiResponse({ transcript: codeSwitched }));

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.text).toBe(codeSwitched);
        expect(result.structured.transcript).toBe(codeSwitched);
    });

    test("throws AITranscriptionError when the response text is empty", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ transcript: "" })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const err = await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
        expect(err.message).toMatch(/no text/);
    });

    test("throws AITranscriptionError when the response text is only whitespace", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ transcript: "   \n  " })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await expectAITranscriptionError(ai.transcribeStreamDetailed(makeFileStream()));
    });

    test("does not parse the transcript as JSON", async () => {
        setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse({ transcript: "not-json{{{ hello" })
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
            makeValidGeminiResponse({ response: { modelVersion: "gemini-3.5-transcribe" } })
        );

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const result = await ai.transcribeStreamDetailed(makeFileStream());

        expect(result.modelVersion).toBe("gemini-3.5-transcribe");
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
            text: DEFAULT_TRANSCRIPT,
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
                transcript: "Hello from transcribeStream",
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

describe("transcribeStreamPreciseDetailed/transcribeStreamPrecise", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("uses gpt-4o-transcribe for precise detailed transcription", async () => {
        const { createTranscription } = setupMockOpenAIClient({
            text: "precise transcript",
            language: "en",
        });
        const caps = makeMockCapabilities();
        const ai = make(() => caps);

        const fileStream = makeFileStream("/tmp/fragment.webm");
        const signal = new AbortController().signal;
        const result = await ai.transcribeStreamPreciseDetailed(fileStream, signal);

        expect(createTranscription).toHaveBeenCalledWith(
            {
                file: fileStream,
                model: PRECISE_TRANSCRIBER_MODEL,
                response_format: "json",
            },
            { signal }
        );
        expect(result.provider).toBe("OpenAI");
        expect(result.model).toBe(PRECISE_TRANSCRIBER_MODEL);
        expect(result.structured.transcript).toBe("precise transcript");
    });

    test("returns text in transcribeStreamPrecise", async () => {
        setupMockOpenAIClient({ text: "precise transcript" });
        const caps = makeMockCapabilities();
        const ai = make(() => caps);

        const signal = new AbortController().signal;
        await expect(ai.transcribeStreamPrecise(makeFileStream("/tmp/fragment.mp3"), signal)).resolves.toBe(
            "precise transcript"
        );
    });

    test("throws AITranscriptionError when precise transcription request fails", async () => {
        setupMockOpenAIClient(new Error("network down"));
        const caps = makeMockCapabilities();
        const ai = make(() => caps);

        const signal = new AbortController().signal;
        await expectAITranscriptionError(ai.transcribeStreamPreciseDetailed(makeFileStream("/tmp/fragment.mp3"), signal));
    });
});

// ---------------------------------------------------------------------------
// Guard: the short/chunk path stays on OpenAI gpt-4o-transcribe.
//
// Whole-file transcription moved to a dedicated Gemini ASR model. These tests
// pin the chunk path so that move cannot quietly drag the chunk path along:
// they fail if the chunk backend, its model, its request shape, or its
// provider changes.
// ---------------------------------------------------------------------------

describe("guard: short/chunk path stays on OpenAI gpt-4o-transcribe", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("the precise model constant is gpt-4o-transcribe and is not the whole-file model", () => {
        expect(PRECISE_TRANSCRIBER_MODEL).toBe("gpt-4o-transcribe");
        expect(TRANSCRIBER_MODEL).not.toBe(PRECISE_TRANSCRIBER_MODEL);
    });

    test("the chunk path never constructs a Gemini client", async () => {
        const { createTranscription } = setupMockOpenAIClient({ text: "chunk" });

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamPreciseDetailed(
            makeFileStream("/tmp/fragment.webm"),
            new AbortController().signal
        );

        expect(createTranscription).toHaveBeenCalledTimes(1);
        expect(GoogleGenAI).not.toHaveBeenCalled();
    });

    test("the chunk request carries no transcription-mode, language, or vocabulary parameters", async () => {
        const { createTranscription } = setupMockOpenAIClient({ text: "chunk" });

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamPreciseDetailed(
            makeFileStream("/tmp/fragment.webm"),
            new AbortController().signal
        );

        // One audio part per request: no chunking or stitching parameters may appear here.
        expect(Object.keys(createTranscription.mock.calls[0][0]).sort()).toEqual([
            "file",
            "model",
            "response_format",
        ]);
    });

    test("the chunk path forwards the abort signal unchanged", async () => {
        const { createTranscription } = setupMockOpenAIClient({ text: "chunk" });

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        const controller = new AbortController();
        await ai.transcribeStreamPrecise(makeFileStream("/tmp/fragment.webm"), controller.signal);

        expect(createTranscription.mock.calls[0][1]).toEqual({ signal: controller.signal });
    });

    test("the whole-file path never constructs an OpenAI client", async () => {
        const { mockGenerateContent } = setupMockClient(
            makeUploadedFile(),
            makeValidGeminiResponse()
        );
        setupMockOpenAIClient({ text: "must not be used" });

        const caps = makeMockCapabilities();
        const ai = make(() => caps);
        await ai.transcribeStreamDetailed(makeFileStream());

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        expect(OpenAI).not.toHaveBeenCalled();
    });
});
