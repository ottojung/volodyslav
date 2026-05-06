const { EventEmitter } = require("events");
const {
    computeTranscriptionTimeoutMs,
    isLiveDiaryTranscriptionTimeoutError,
    transcribeBuffer,
} = require("../src/live_diary/transcribe_utils");

class FakeStream extends EventEmitter {
    destroy() {}
}

function makeCapabilities(transcribeStreamPreciseDetailed) {
    return {
        aiTranscription: { transcribeStreamPreciseDetailed },
        logger: { logDebug() {}, logWarning() {}, logError() {} },
        creator: {
            async createTemporaryDirectory() { return "/tmp/live-diary"; },
            async createFile() { return "/tmp/live-diary/diary.wav"; },
        },
        writer: { async writeBuffer() {} },
        reader: {
            createReadStream() {
                const stream = new FakeStream();
                setImmediate(() => stream.emit("open"));
                return stream;
            },
        },
        deleter: { async deleteDirectory() {} },
    };
}

describe("computeTranscriptionTimeoutMs", () => {
    it("increases timeout with audio byte size", () => {
        const small = computeTranscriptionTimeoutMs(1_000_000);
        const large = computeTranscriptionTimeoutMs(10_000_000);
        expect(large).toBeGreaterThan(small);
    });

    it("caps generation component for very large uploads", () => {
        const timeout = computeTranscriptionTimeoutMs(500_000_000);
        const expectedUploadMs = Math.ceil(500_000_000 / (1024 * 1024 / 1000));
        expect(timeout).toBe(expectedUploadMs + 80_000 + 10_000);
    });
});

describe("transcribeBuffer", () => {
    it("aborts the sdk signal when timeout fires", async () => {
        /** @type {AbortSignal | undefined} */
        let receivedSignal;
        const capabilities = makeCapabilities(async (_stream, signal) => {
            receivedSignal = signal;
            return new Promise(() => {});
        });

        const timeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation((fn) => {
            fn();
            return /** @type {ReturnType<typeof setTimeout>} */ (1);
        });

        const error = await transcribeBuffer(
            Buffer.alloc(1),
            "audio/wav",
            capabilities,
            new AbortController().signal
        ).catch((caught) => caught);

        timeoutSpy.mockRestore();

        expect(isLiveDiaryTranscriptionTimeoutError(error)).toBe(true);
        expect(receivedSignal && receivedSignal.aborted).toBe(true);
    });

    it("forwards caller abort signal to the sdk call", async () => {
        const outerController = new AbortController();

        const capabilities = makeCapabilities(async (_stream, signal) => {
            outerController.abort("stop");
            return { structured: { transcript: signal.aborted ? "aborted" : "running" } };
        });

        const result = await transcribeBuffer(Buffer.alloc(1), "audio/wav", capabilities, outerController.signal);
        expect(result).toBe("aborted");
    });
});
