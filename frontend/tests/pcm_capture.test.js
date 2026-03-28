/**
 * Unit tests for pcm_capture internals: downsample() and drainWav().
 *
 * drainWav() is a method of the internal PcmCaptureClass, so a minimal
 * AudioContext stub with createScriptProcessor is used together with
 * makePcmCapture() to obtain a live instance.
 */

import { downsample, buildWavBlob, makePcmCapture } from "../src/AudioDiary/pcm_capture.js";

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
        const out = downsample(input, 16000, 16000);
        expect(out).toBeInstanceOf(Int16Array);
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
        const out = downsample(input, 48000, 16000);
        expect(out).toBeInstanceOf(Int16Array);
        expect(out.length).toBe(3); // 9 / 3 = 3
        for (const s of out) {
            expect(s).toBeCloseTo(8192, -1); // 0.25 * 32767 ≈ 8192
        }
    });

    it("handles upsampling (fromRate < toRate) without division by zero", () => {
        // fromRate < toRate falls through to the scalar path.
        const input = new Float32Array([0.5, -0.5]);
        expect(() => downsample(input, 8000, 16000)).not.toThrow();
        const out = downsample(input, 8000, 16000);
        expect(out).toBeInstanceOf(Int16Array);
        expect(out.length).toBe(2);
        expect(out[0]).toBeCloseTo(16384, -1);
        expect(out[1]).toBeCloseTo(-16384, -1);
    });

    it("handles empty input", () => {
        const out = downsample(new Float32Array(0), 48000, 16000);
        expect(out).toBeInstanceOf(Int16Array);
        expect(out.length).toBe(0);
    });

    it("clamps values at ±1 to the Int16 range", () => {
        const input = new Float32Array([1.5, -1.5]);
        const out = downsample(input, 16000, 16000);
        expect(out[0]).toBe(32767);
        expect(out[1]).toBe(-32768);
    });
});

// ---------------------------------------------------------------------------
// buildWavBlob()
// ---------------------------------------------------------------------------

describe("buildWavBlob()", () => {
    it("returns a Blob with audio/wav type", () => {
        const samples = new Int16Array([0, 100, -100, 200]);
        const blob = buildWavBlob(samples, 16000);
        expect(blob).toBeInstanceOf(Blob);
        expect(blob.type).toBe("audio/wav");
    });

    it("produced blob is larger than the raw PCM (has a header)", () => {
        const samples = new Int16Array(160); // 10 ms @ 16 kHz
        const blob = buildWavBlob(samples, 16000);
        expect(blob.size).toBeGreaterThan(samples.byteLength);
    });
});

// ---------------------------------------------------------------------------
// drainWav() via PcmCaptureClass (through makePcmCapture)
// ---------------------------------------------------------------------------

describe("drainWav()", () => {
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
        expect(capture.drainWav(1000)).toBeNull();
    });

    it("returns a WAV Blob when samples are present", () => {
        // Feed 160 samples (10 ms at 16 kHz, already at target rate)
        // Context sample rate is 48000 so downsample(160 samples @ 48kHz → 16kHz)
        // gives Math.floor(160 / 3) = 53 samples — still non-zero.
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.1));
        const wav = capture.drainWav(1000);
        expect(wav).toBeInstanceOf(Blob);
        expect(wav.type).toBe("audio/wav");
    });

    it("drains samples and resets internal buffer", () => {
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.1));
        const wav1 = capture.drainWav(10000);
        expect(wav1).not.toBeNull();
        // A second drain with no new samples should return null.
        const wav2 = capture.drainWav(10000);
        expect(wav2).toBeNull();
    });

    it("carries over excess samples to the next drain", () => {
        // Feed enough samples for 30 ms at 48 kHz = 1440 Float32 samples.
        // After downsampling to 16 kHz: Math.floor(1440 / 3) = 480 samples.
        // durationMs=10 expects 160 samples at 16 kHz; excess 320 are kept.
        fireAudioProcess(scriptNode, new Float32Array(1440).fill(0.2));
        const wav1 = capture.drainWav(10); // 10 ms → expect 160 samples drained
        expect(wav1).not.toBeNull();

        // The second drain should still have samples from the carryover.
        const wav2 = capture.drainWav(10000); // large window — drain all remaining
        expect(wav2).not.toBeNull();
    });

    it("discards accumulated samples on pause()", () => {
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.1));
        capture.pause();
        // After pause, nothing new is accumulated — drain returns null.
        const wav = capture.drainWav(10000);
        expect(wav).toBeNull();
    });

    it("ignores samples fed while paused", () => {
        capture.pause();
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.5));
        const wav = capture.drainWav(10000);
        expect(wav).toBeNull();
    });

    it("resumes accumulation after resume()", () => {
        capture.pause();
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.5)); // ignored
        capture.resume();
        fireAudioProcess(scriptNode, new Float32Array(160).fill(0.2)); // captured
        const wav = capture.drainWav(10000);
        expect(wav).not.toBeNull();
    });
});
