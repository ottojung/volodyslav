/**
 * Unit tests for live_diary/assembler.js.
 */

const {
    assemblePcm,
    silenceBuffer,
    AssemblerFormatMismatchError,
    AssemblerInvalidFragmentError,
    isAssemblerFormatMismatchError,
    isAssemblerInvalidFragmentError,
} = require("../src/live_diary/assembler");

const FORMAT = { sampleRateHz: 16000, channels: 1, bitDepth: 16 };
const FRAME_SIZE = FORMAT.channels * (FORMAT.bitDepth / 8); // 2 bytes

/**
 * Build a PCM buffer of N frames, each frame containing sequential byte values
 * (wrapped at 256) so we can detect which portion ends up in the output.
 * @param {number} durationMs
 * @returns {Buffer}
 */
function makePcm(durationMs) {
    const frames = Math.ceil(durationMs * FORMAT.sampleRateHz / 1000);
    const buf = Buffer.allocUnsafe(frames * FRAME_SIZE);
    for (let i = 0; i < buf.length; i++) {
        buf[i] = i % 256;
    }
    return buf;
}

describe("assemblePcm", () => {
    it("returns empty buffer for zero-length window", () => {
        const result = assemblePcm({
            fragments: [],
            windowStartMs: 1000,
            windowEndMs: 1000,
            ...FORMAT,
        });
        expect(result.length).toBe(0);
    });

    it("returns silence when no fragments intersect the window", () => {
        const fragments = [
            {
                sequence: 0,
                startMs: 30_000,
                endMs: 40_000,
                pcm: makePcm(10_000),
                ...FORMAT,
            },
        ];
        const result = assemblePcm({
            fragments,
            windowStartMs: 0,
            windowEndMs: 10_000,
            ...FORMAT,
        });
        // 10 seconds of silence at 16 kHz mono 16-bit = 16000 * 2 = 32000 bytes
        expect(result.length).toBe(10_000 * FORMAT.sampleRateHz / 1000 * FRAME_SIZE);
        expect(result.every((b) => b === 0)).toBe(true);
    });

    it("returns a single fragment's PCM when window exactly covers it", () => {
        const pcm = makePcm(10_000);
        const fragments = [
            { sequence: 0, startMs: 0, endMs: 10_000, pcm, ...FORMAT },
        ];
        const result = assemblePcm({
            fragments,
            windowStartMs: 0,
            windowEndMs: 10_000,
            ...FORMAT,
        });
        expect(result).toEqual(pcm);
    });

    it("slices a fragment correctly when window starts after fragment start", () => {
        const pcm = makePcm(20_000); // 20 s
        const fragments = [
            { sequence: 0, startMs: 0, endMs: 20_000, pcm, ...FORMAT },
        ];
        const result = assemblePcm({
            fragments,
            windowStartMs: 10_000,
            windowEndMs: 20_000,
            ...FORMAT,
        });
        // Should be the second half of pcm
        const byteStart = 10_000 * FORMAT.sampleRateHz / 1000 * FRAME_SIZE;
        expect(result).toEqual(pcm.slice(byteStart));
    });

    it("slices a fragment correctly when window ends before fragment end", () => {
        const pcm = makePcm(20_000);
        const fragments = [
            { sequence: 0, startMs: 0, endMs: 20_000, pcm, ...FORMAT },
        ];
        const result = assemblePcm({
            fragments,
            windowStartMs: 0,
            windowEndMs: 10_000,
            ...FORMAT,
        });
        const byteEnd = 10_000 * FORMAT.sampleRateHz / 1000 * FRAME_SIZE;
        expect(result).toEqual(pcm.slice(0, byteEnd));
    });

    it("concatenates two contiguous fragments correctly", () => {
        const pcm1 = makePcm(10_000);
        const pcm2 = makePcm(10_000);
        const fragments = [
            { sequence: 0, startMs: 0, endMs: 10_000, pcm: pcm1, ...FORMAT },
            { sequence: 1, startMs: 10_000, endMs: 20_000, pcm: pcm2, ...FORMAT },
        ];
        const result = assemblePcm({
            fragments,
            windowStartMs: 0,
            windowEndMs: 20_000,
            ...FORMAT,
        });
        expect(result).toEqual(Buffer.concat([pcm1, pcm2]));
    });

    it("fills gap between non-contiguous fragments with silence", () => {
        const pcm1 = makePcm(5_000);
        const pcm2 = makePcm(5_000);
        const fragments = [
            { sequence: 0, startMs: 0, endMs: 5_000, pcm: pcm1, ...FORMAT },
            // 5-second gap at [5000, 10000)
            { sequence: 1, startMs: 10_000, endMs: 15_000, pcm: pcm2, ...FORMAT },
        ];
        const result = assemblePcm({
            fragments,
            windowStartMs: 0,
            windowEndMs: 15_000,
            ...FORMAT,
        });
        const silenceLen = 5_000 * FORMAT.sampleRateHz / 1000 * FRAME_SIZE;
        const expectedLen = pcm1.length + silenceLen + pcm2.length;
        expect(result.length).toBe(expectedLen);
        // Middle portion should be silence.
        const middle = result.slice(pcm1.length, pcm1.length + silenceLen);
        expect(middle.every((b) => b === 0)).toBe(true);
    });

    it("throws AssemblerInvalidFragmentError for fragment with endMs <= startMs", () => {
        const fragments = [
            { sequence: 0, startMs: 5_000, endMs: 5_000, pcm: Buffer.alloc(0), ...FORMAT },
        ];
        expect(() =>
            assemblePcm({ fragments, windowStartMs: 0, windowEndMs: 10_000, ...FORMAT })
        ).toThrow(AssemblerInvalidFragmentError);
    });

    it("throws AssemblerFormatMismatchError for fragment with wrong sampleRateHz", () => {
        const fragments = [
            {
                sequence: 0, startMs: 0, endMs: 10_000, pcm: makePcm(10_000),
                sampleRateHz: 44100, channels: FORMAT.channels, bitDepth: FORMAT.bitDepth,
            },
        ];
        expect(() =>
            assemblePcm({ fragments, windowStartMs: 0, windowEndMs: 10_000, ...FORMAT })
        ).toThrow(AssemblerFormatMismatchError);
    });

    it("isAssemblerFormatMismatchError returns true for format mismatch errors", () => {
        const err = new AssemblerFormatMismatchError("mismatch", 0);
        expect(isAssemblerFormatMismatchError(err)).toBe(true);
    });

    it("isAssemblerInvalidFragmentError returns true for invalid fragment errors", () => {
        const err = new AssemblerInvalidFragmentError("invalid", 0);
        expect(isAssemblerInvalidFragmentError(err)).toBe(true);
    });

    it("handles mixed-length fragments (1s, 2.7s, 5s) correctly", () => {
        // Cadence-agnostic: fragment lengths don't need to be equal.
        const frag1 = makePcm(1_000);
        const frag2 = makePcm(2_700);
        const frag3 = makePcm(5_000);
        // Fragment 2 starts at 1000, ends at 3700. Fragment 3 starts at 3700, ends at 8700.
        const fragments = [
            { sequence: 0, startMs: 0, endMs: 1_000, pcm: frag1, ...FORMAT },
            { sequence: 1, startMs: 1_000, endMs: 3_700, pcm: frag2, ...FORMAT },
            { sequence: 2, startMs: 3_700, endMs: 8_700, pcm: frag3, ...FORMAT },
        ];
        const result = assemblePcm({
            fragments,
            windowStartMs: 0,
            windowEndMs: 8_700,
            ...FORMAT,
        });
        const expectedLen = (frag1.length + frag2.length + frag3.length);
        expect(result.length).toBe(expectedLen);
    });

    it("sorts fragments by (startMs, sequence) when out of order", () => {
        const pcm1 = makePcm(5_000);
        const pcm2 = makePcm(5_000);
        const fragmentsOutOfOrder = [
            { sequence: 1, startMs: 5_000, endMs: 10_000, pcm: pcm2, ...FORMAT },
            { sequence: 0, startMs: 0, endMs: 5_000, pcm: pcm1, ...FORMAT },
        ];
        const result = assemblePcm({
            fragments: fragmentsOutOfOrder,
            windowStartMs: 0,
            windowEndMs: 10_000,
            ...FORMAT,
        });
        // Should be correctly ordered: pcm1 then pcm2
        expect(result).toEqual(Buffer.concat([pcm1, pcm2]));
    });
});

describe("silenceBuffer", () => {
    it("returns all-zero buffer for the given duration", () => {
        const buf = silenceBuffer(1_000, 16000, 1, 16);
        expect(buf.length).toBe(1_000 * 16000 / 1000 * 2); // 32000 bytes
        expect(buf.every((b) => b === 0)).toBe(true);
    });

    it("returns empty buffer for zero duration", () => {
        const buf = silenceBuffer(0, 16000, 1, 16);
        expect(buf.length).toBe(0);
    });
});
