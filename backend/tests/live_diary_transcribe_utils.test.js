const {
    computeTranscriptionTimeoutMs,
} = require("../src/live_diary/transcribe_utils");

describe("computeTranscriptionTimeoutMs", () => {
    it("increases timeout with audio byte size", () => {
        const small = computeTranscriptionTimeoutMs(1_000_000);
        const large = computeTranscriptionTimeoutMs(10_000_000);

        expect(large).toBeGreaterThan(small);
    });

    it("caps generation component for very large uploads", () => {
        const timeout = computeTranscriptionTimeoutMs(500_000_000);
        const expectedUploadMs = Math.ceil(500_000_000 / (1024 * 1024 / 1000));
        const expected = expectedUploadMs + 80_000 + 10_000;
        expect(timeout).toBe(expected);
    });
});
