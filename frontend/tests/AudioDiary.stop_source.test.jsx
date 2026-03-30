/**
 * Unit tests for the stop source selection logic in createRecorderCallbacks.
 *
 * Verifies:
 * 1. Uninterrupted stop does NOT call fetchFinalAudio.
 * 2. Uninterrupted stop keeps local blob as final preview source.
 * 3. Restored/interrupted stop DOES call fetchFinalAudio.
 * 4. Restored/interrupted stop replaces local blob with backend blob.
 */

jest.mock("../src/AudioDiary/session_api.js", () => ({
    stopSession: jest.fn().mockResolvedValue({ status: "stopped", size: 0 }),
    fetchFinalAudio: jest
        .fn()
        .mockResolvedValue(new Blob(["backend-audio"], { type: "audio/wav" })),
    discardSession: jest.fn().mockResolvedValue(undefined),
    pushPcmWithSessionRetry: jest.fn().mockResolvedValue({ status: "accepted" }),
}));

jest.mock("../src/AudioDiary/recording_storage.js", () => ({
    clearSessionId: jest.fn(),
    saveSessionId: jest.fn(),
    loadSessionId: jest.fn().mockReturnValue(null),
}));

import { createRecorderCallbacks } from "../src/AudioDiary/useAudioRecorder_recorder_callbacks.js";
import { fetchFinalAudio, stopSession, discardSession } from "../src/AudioDiary/session_api.js";

/** Wait for all pending microtasks and macrotasks to settle. */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 20));

/** @type {jest.Mock} */
let mockCreateObjectURL;
/** @type {jest.Mock} */
let mockRevokeObjectURL;
/** @type {typeof URL.createObjectURL} */
let originalCreateObjectURL;
/** @type {typeof URL.revokeObjectURL} */
let originalRevokeObjectURL;

beforeAll(() => {
    originalCreateObjectURL = global.URL.createObjectURL;
    originalRevokeObjectURL = global.URL.revokeObjectURL;
    mockCreateObjectURL = jest.fn().mockReturnValue("blob:mock-url");
    mockRevokeObjectURL = jest.fn();
    global.URL.createObjectURL = mockCreateObjectURL;
    global.URL.revokeObjectURL = mockRevokeObjectURL;
});

afterAll(() => {
    jest.restoreAllMocks();
    global.URL.createObjectURL = originalCreateObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL;
});

beforeEach(() => {
    jest.clearAllMocks();
    stopSession.mockResolvedValue({ status: "stopped", size: 0 });
    fetchFinalAudio.mockResolvedValue(
        new Blob(["backend-audio"], { type: "audio/wav" })
    );
    mockCreateObjectURL.mockReturnValue("blob:mock-url");
});

/**
 * Build a minimal set of refs and setters for createRecorderCallbacks.
 * @param {{ hasRestoredSession?: boolean, pcmUploaded?: number, sessionId?: string }} [overrides]
 */
function makeParams(overrides = {}) {
    const { hasRestoredSession = false, pcmUploaded = 1, sessionId = "test-session-id" } = overrides;

    /** @type {import("react").MutableRefObject<Blob | null>} */
    const audioBlobRef = { current: null };
    /** @type {import("react").MutableRefObject<string>} */
    const mimeTypeRef = { current: "" };

    return {
        params: {
            isMountedRef: { current: true },
            recorderStateRef: { current: "recording" },
            setRecorderState: jest.fn(),
            setAudioBlob: jest.fn(),
            setAudioUrl: jest.fn(),
            setAnalyser: jest.fn(),
            setErrorMessage: jest.fn(),
            sessionIdRef: { current: sessionId },
            pcmUploadedCountRef: { current: pcmUploaded },
            uploadQueueRef: { current: Promise.resolve() },
            audioBlobRef,
            mimeTypeRef,
            restoredOffsetMsRef: { current: 0 },
            sequenceRef: { current: 0 },
            hasRestoredSessionRef: { current: hasRestoredSession },
        },
        localBlob: new Blob(["local-audio"], { type: "audio/webm" }),
        audioBlobRef,
        mimeTypeRef,
    };
}

describe("createRecorderCallbacks: stop source selection", () => {
    it("uninterrupted stop does not call fetchFinalAudio", async () => {
        const { params, localBlob } = makeParams({ hasRestoredSession: false });
        const { onStop } = createRecorderCallbacks(params);

        onStop(localBlob);
        await flushAsync();

        expect(fetchFinalAudio).not.toHaveBeenCalled();
    });

    it("uninterrupted stop keeps local blob as the final audio source", async () => {
        const { params, localBlob, audioBlobRef } = makeParams({
            hasRestoredSession: false,
        });
        const { onStop } = createRecorderCallbacks(params);

        onStop(localBlob);
        await flushAsync();

        expect(audioBlobRef.current).toBe(localBlob);
        expect(params.setAudioBlob).toHaveBeenCalledWith(localBlob);
    });

    it("restored/interrupted stop calls fetchFinalAudio", async () => {
        const { params, localBlob } = makeParams({ hasRestoredSession: true });
        const { onStop } = createRecorderCallbacks(params);

        onStop(localBlob);
        await flushAsync();

        expect(fetchFinalAudio).toHaveBeenCalledWith("test-session-id");
    });

    it("restored/interrupted stop replaces local blob with backend blob", async () => {
        const backendBlob = new Blob(["backend-audio"], { type: "audio/wav" });
        fetchFinalAudio.mockResolvedValueOnce(backendBlob);

        const { params, localBlob, audioBlobRef } = makeParams({
            hasRestoredSession: true,
        });
        const { onStop } = createRecorderCallbacks(params);

        onStop(localBlob);
        await flushAsync();

        expect(audioBlobRef.current).toBe(backendBlob);
        expect(params.setAudioBlob).toHaveBeenLastCalledWith(backendBlob);
    });

    it("uninterrupted stop calls stopSession on backend", async () => {
        const { params, localBlob } = makeParams({ hasRestoredSession: false });
        const { onStop } = createRecorderCallbacks(params);

        onStop(localBlob);
        await flushAsync();

        expect(stopSession).toHaveBeenCalledWith("test-session-id");
    });

    it("discards session and skips stop when no PCM was uploaded", async () => {
        const { params, localBlob } = makeParams({ pcmUploaded: 0 });
        const { onStop } = createRecorderCallbacks(params);

        onStop(localBlob);
        await flushAsync();

        expect(discardSession).toHaveBeenCalledWith("test-session-id");
        expect(stopSession).not.toHaveBeenCalled();
        expect(fetchFinalAudio).not.toHaveBeenCalled();
    });

    it("uninterrupted stop with empty (size=0) blob forces backend fallback", async () => {
        const { params } = makeParams({ hasRestoredSession: false });
        const emptyBlob = new Blob([], { type: "audio/webm" });
        const { onStop } = createRecorderCallbacks(params);

        onStop(emptyBlob);
        await flushAsync();

        expect(fetchFinalAudio).toHaveBeenCalledWith("test-session-id");
    });
});
