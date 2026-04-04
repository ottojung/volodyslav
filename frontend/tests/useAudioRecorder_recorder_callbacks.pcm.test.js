jest.mock("../src/AudioDiary/session_api.js", () => ({
    stopSession: jest.fn().mockResolvedValue({ status: "stopped", size: 0 }),
    fetchFinalAudio: jest
        .fn()
        .mockResolvedValue(new Blob(["backend-audio"], { type: "audio/wav" })),
    discardSession: jest.fn().mockResolvedValue(undefined),
    pushPcmWithSessionRetry: jest.fn().mockResolvedValue({ status: "accepted" }),
}));

import { createRecorderCallbacks } from "../src/AudioDiary/useAudioRecorder_recorder_callbacks.js";
import { pushPcmWithSessionRetry } from "../src/AudioDiary/session_api.js";

function makeParams() {
    return {
        isMountedRef: { current: true },
        recorderStateRef: { current: "recording" },
        setRecorderState: jest.fn(),
        setAudioBlob: jest.fn(),
        setAudioUrl: jest.fn(),
        setAnalyser: jest.fn(),
        setErrorMessage: jest.fn(),
        sessionIdRef: { current: "session-1" },
        pcmUploadedCountRef: { current: 0 },
        uploadQueueRef: { current: Promise.resolve() },
        audioBlobRef: { current: null },
        mimeTypeRef: { current: "" },
        restoredOffsetMsRef: { current: 0 },
        sequenceRef: { current: -1 },
        hasRestoredSessionRef: { current: false },
    };
}

describe("createRecorderCallbacks onPcmFragment", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("uploads each fragment with increasing sequence and exact time bounds", async () => {
        const params = makeParams();
        const { onPcmFragment } = createRecorderCallbacks(params);

        const chunk1 = {
            pcmBytes: new Uint8Array([1, 2]).buffer,
            sampleRateHz: 16000,
            channels: 1,
            bitDepth: 16,
        };
        const chunk2 = {
            pcmBytes: new Uint8Array([3, 4]).buffer,
            sampleRateHz: 16000,
            channels: 1,
            bitDepth: 16,
        };

        onPcmFragment(0, 1000, chunk1);
        onPcmFragment(1000, 2000, chunk2);
        await params.uploadQueueRef.current;

        expect(pushPcmWithSessionRetry).toHaveBeenCalledTimes(2);
        expect(pushPcmWithSessionRetry).toHaveBeenNthCalledWith(1, "session-1", {
            pcmBytes: chunk1.pcmBytes,
            sampleRateHz: 16000,
            channels: 1,
            bitDepth: 16,
            startMs: 0,
            endMs: 1000,
            sequence: 0,
        });
        expect(pushPcmWithSessionRetry).toHaveBeenNthCalledWith(2, "session-1", {
            pcmBytes: chunk2.pcmBytes,
            sampleRateHz: 16000,
            channels: 1,
            bitDepth: 16,
            startMs: 1000,
            endMs: 2000,
            sequence: 1,
        });
    });
});
