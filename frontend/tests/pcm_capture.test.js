/**
 * Unit tests for pcm_capture internals: downsample() and drainPcm().
 *
 * drainPcm() is a method of the internal PcmCaptureClass, so a minimal
 * AudioContext stub with createScriptProcessor is used together with
 * makePcmCapture() to obtain a live instance.
 */

import { downsample, makePcmCapture } from "../src/AudioDiary/pcm_capture.js";

// ---------------------------------------------------------------------------
// Browser API stubs (not available in jsdom)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake ScriptProcessorNode. */
function makeFakeScriptNode() {
    return {
        onaudioprocess: null,
        connect: jest.fn(),
    };
}

/** Build a fake GainNode. */
function makeFakeGainNode() {
    return {
        gain: { value: 0 },
        connect: jest.fn(),
    };
}

/**
 * Build a minimal AudioContext stub that will succeed the ScriptProcessor path.
 * Returns an object with the stub plus a reference to the created script node.
 */
function makeFakeAudioContext(sampleRate = 48000) {
    const scriptNode = makeFakeScriptNode();
    const gainNode = makeFakeGainNode();
    const ctx = {
        sampleRate,
        audioWorklet: null,   // force ScriptProcessor fallback
        destination: {},
        createScriptProcessor: jest.fn(() => scriptNode),
        createGain: jest.fn(() => gainNode),
        _scriptNode: scriptNode,
        _gainNode: gainNode,
    };
    return ctx;
}

/** Build a minimal MediaStreamAudioSourceNode stub. */
function makeFakeSourceNode() {
    return { connect: jest.fn() };
}

/**
 * Fire an onaudioprocess event on the script node with the given Float32 samples.
 * @param {object} scriptNode
 * @param {Float32Array} samples
 */
function fireAudioProcess(scriptNode, samples) {
    if (typeof scriptNode.onaudioprocess === "function") {
        scriptNode.onaudioprocess({
            inputBuffer: {
                getChannelData: () => samples,
            },
        });
    }
}

// ---------------------------------------------------------------------------
// downsample()
// ---------------------------------------------------------------------------

describe("downsample()", () => {
    it("identity (fromRate === toRate) converts Float32 to Int16", () => {
        const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
        const result = downsample(input, 16000, 16000);
        const out = result.samples;
        expect(out).toBeInstanceOf(Int16Array);
        expect(result.consumedInput).toBe(input.length);
        expect(result.consumedOffset).toBe(0);
        expect(out.length).toBe(5);
        expect(out[0]).toBe(0);
        expect(out[1]).toBeCloseTo(16384, -1);    // 0.5 * 32767 ≈ 16383
        expect(out[2]).toBeCloseTo(-16384, -1);   // -0.5 * 32767 ≈ -16384
        expect(out[3]).toBe(32767);               // clamp to max (+1.0 * 32767 = 32767)
        expect(out[4]).toBe(-32767);              // -1.0 * 32767 = -32767 (clamp to -32768 for values < -32767)
    });

    it("downsamples 48 kHz → 16 kHz (3:1)", () => {
        // A constant 0.25 signal — after averaging still 0.25.
        const input = new Float32Array(9).fill(0.25);
        const result = downsample(input, 48000, 16000);
        const out = result.samples;
        expect(out).toBeInstanceOf(Int16Array);
        expect(result.consumedInput).toBe(9);
        expect(result.consumedOffset).toBe(0);
        expect(out.length).toBe(3); // 9 / 3 = 3
        for (const s of out) {
            expect(s).toBeCloseTo(8192, -1); // 0.25 * 32767 ≈ 8192
        }
    });

    it("handles upsampling (fromRate < toRate) without division by zero", () => {
        // fromRate < toRate falls through to the scalar path.
        const input = new Float32Array([0.5, -0.5]);
        expect(() => downsample(input, 8000, 16000)).not.toThrow();
        const result = downsample(input, 8000, 16000);
        const out = result.samples;
        expect(out).toBeInstanceOf(Int16Array);
        expect(result.consumedInput).toBe(input.length);
        expect(result.consumedOffset).toBe(0);
        expect(out.length).toBe(2);
        expect(out[0]).toBeCloseTo(16384, -1);
        expect(out[1]).toBeCloseTo(-16384, -1);
    });

    it("handles empty input", () => {
        const result = downsample(new Float32Array(0), 48000, 16000);
        const out = result.samples;
        expect(out).toBeInstanceOf(Int16Array);
        expect(result.consumedInput).toBe(0);
        expect(result.consumedOffset).toBe(0);
        expect(out.length).toBe(0);
    });

    it("clamps values at ±1 to the Int16 range", () => {
        const input = new Float32Array([1.5, -1.5]);
        const out = downsample(input, 16000, 16000).samples;
        expect(out[0]).toBe(32767);
        expect(out[1]).toBe(-32768);
    });

    it("handles non-integer ratio downsampling (44.1 kHz → 16 kHz) without overlap", () => {
        // Constant signal keeps expected value stable while verifying interval math.
        const input = new Float32Array(45).fill(0.25);
        const result = downsample(input, 44100, 16000);
        expect(result.samples.length).toBe(16); // Math.floor(45 * 16000 / 44100)
        expect(result.consumedInput).toBe(44);  // one source sample remains as remainder
        expect(result.consumedOffset).toBeCloseTo(0.1, 6); // 0.1 of the boundary sample was consumed
        for (const s of result.samples) {
            expect(s).toBeCloseTo(8192, -1);
        }
    });

    it("accepts startOffset and advances fractional consumption continuously", () => {
        const input = new Float32Array(4).fill(0.25);
        const result = downsample(input, 44100, 16000, 0.1);
        expect(result.samples.length).toBe(1);
        expect(result.consumedInput).toBe(2);
        expect(result.consumedOffset).toBeCloseTo(0.85625, 6);
    });
});

// ---------------------------------------------------------------------------
// drainPcm() via PcmCaptureClass (through makePcmCapture)
// ---------------------------------------------------------------------------

describe("drainPcm()", () => {
    let capture;
    let scriptNode;

    beforeEach(async () => {
        const ctx = makeFakeAudioContext(48000);
        const src = makeFakeSourceNode();
        capture = await makePcmCapture(ctx, src);
        if (!capture) throw new Error("makePcmCapture returned null — capture setup failed");
        scriptNode = ctx._scriptNode;
    });

    afterEach(() => {
        capture.close();
    });

    it("returns null when no samples have been collected", () => {
        expect(capture.drainPcm(1000)).toBeNull();
    });

    it("returns a PCM result with correct metadata when samples are present", () => {
        // Feed 160 samples (10 ms at 16 kHz, already at target rate)
        // Context sample rate is 48000 so downsample(160 samples @ 48kHz → 16kHz)
        // gives Math.floor(160 / 3) = 53 samples — still non-zero.
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.1));
        const pcm = capture.drainPcm(1000);
        expect(pcm).not.toBeNull();
        expect(pcm.pcmBytes).toBeInstanceOf(ArrayBuffer);
        expect(pcm.sampleRateHz).toBe(16000);
        expect(pcm.channels).toBe(1);
        expect(pcm.bitDepth).toBe(16);
    });

    it("drains samples and resets internal buffer", () => {
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.1));
        const pcm1 = capture.drainPcm(10000);
        expect(pcm1).not.toBeNull();
        // A second drain with no new samples should return null.
        const pcm2 = capture.drainPcm(10000);
        expect(pcm2).toBeNull();
    });

    it("carries over excess samples to the next drain", () => {
        // Feed enough samples for 30 ms at 48 kHz = 1440 Float32 samples.
        // After downsampling to 16 kHz: Math.floor(1440 / 3) = 480 samples.
        // durationMs=10 expects 160 samples at 16 kHz; excess 320 are kept.
        fireAudioProcess(scriptNode, new Float32Array(1440).fill(0.2));
        const pcm1 = capture.drainPcm(10); // 10 ms → expect 160 samples drained
        expect(pcm1).not.toBeNull();
        // The second drain should still have samples from the carryover.
        const pcm2 = capture.drainPcm(10000); // large window — drain all remaining
        expect(pcm2).not.toBeNull();
    });

    it("discards accumulated samples on pause()", () => {
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.1));
        capture.pause();
        // After pause, nothing new is accumulated — drain returns null.
        const pcm = capture.drainPcm(10000);
        expect(pcm).toBeNull();
    });

    it("ignores samples fed while paused", () => {
        capture.pause();
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.5));
        const pcm = capture.drainPcm(10000);
        expect(pcm).toBeNull();
    });

    it("resumes accumulation after resume()", () => {
        capture.pause();
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.5)); // ignored
        capture.resume();
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.2)); // captured
        const pcm = capture.drainPcm(10000);
        expect(pcm).not.toBeNull();
    });

    it("returns null instead of a header-only buffer when floored expected sample count is zero", () => {
        // At 48 kHz, a 2-frame callback downsampled to 16 kHz yields 0 samples.
        fireAudioProcess(scriptNode, new Float32Array([0.2, 0.2]));
        const pcm = capture.drainPcm(0.01); // durationMs=0.01 => floor((16000 * 0.01) / 1000) = floor(0.16) = 0
        expect(pcm).toBeNull();
    });

    it("preserves downsample remainder even when a callback yields zero output samples", () => {
        // First callback has fewer than 3 frames at 48→16 kHz, so output is 0 and
        // frames must be preserved as remainder.
        fireAudioProcess(scriptNode, new Float32Array([0.1, 0.1]));
        // Second callback adds one more frame, making 3 total -> 1 output sample.
        fireAudioProcess(scriptNode, new Float32Array([0.1]));
        const pcm = capture.drainPcm(1000);
        expect(pcm).not.toBeNull();
    });
});
