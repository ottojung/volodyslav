/**
 * Parallel PCM capture for live-diary analysis audio.
 *
 * Captures audio from an existing AudioContext + MediaStreamSource in
 * parallel with MediaRecorder, producing mono PCM16 fragments at a fixed
 * 16 kHz sample rate.  Each fragment can then be uploaded as raw PCM bytes
 * to the backend, which performs all audio preprocessing server-side.
 *
 * Implementation note — capture node choice:
 *   Primary path:  AudioWorkletProcessor.  Runs off the main thread and
 *     avoids the deprecated ScriptProcessorNode.
 *   Fallback path: ScriptProcessorNode.  Used when AudioWorklet is not
 *     available (older browsers).  If neither API is available, PCM
 *     capture degrades to a no-op and makePcmCapture returns null.
 *
 * @module AudioDiary/pcm_capture
 */

/** Target analysis sample rate (Hz). */
const TARGET_SAMPLE_RATE = 16000;

/**
 * AudioWorkletProcessor source code loaded as a Blob URL.
 * The processor passes raw Float32 channel data to the main thread
 * for downsampling.
 */
const WORKLET_PROCESSOR_NAME = "pcm-capture-processor";
const WORKLET_PROCESSOR_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && channel.length > 0) {
            // Copy before transferring so the processor buffer is not detached.
            const copy = new Float32Array(channel);
            this.port.postMessage(copy, [copy.buffer]);
        }
        return true;
    }
}
registerProcessor("${WORKLET_PROCESSOR_NAME}", PcmCaptureProcessor);
`;

// ---------------------------------------------------------------------------
// (WAV builder removed — backend is the single owner of WAV conversion)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Downsampling helper
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DownsampleResult
 * @property {Int16Array} samples
 * @property {number} consumedInput
 * @property {number} consumedOffset
 */

/**
 * Downsample a Float32 mono channel to a target sample rate, returning Int16
 * plus the exact number of input samples consumed to produce the output.
 *
 * When `fromRate` is less than or equal to `toRate` (no downsampling needed)
 * each input sample is converted directly to Int16 without averaging.
 *
 * For downsampling, uses non-overlapping input intervals so each source sample
 * contributes to at most one output interval.
 *
 * @param {Float32Array} input - Input samples at `fromRate` Hz.
 * @param {number} fromRate - Input sample rate.
 * @param {number} toRate - Output sample rate.
 * @param {number} [startOffset=0] - Fractional offset already consumed from input[0], in [0,1).
 * @returns {DownsampleResult}
 */
function downsample(input, fromRate, toRate, startOffset = 0) {
    if (fromRate <= toRate) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const sample = input[i] ?? 0;
            out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
        }
        return { samples: out, consumedInput: input.length, consumedOffset: 0 };
    }
    const ratio = fromRate / toRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    let inputIndex = 0;
    let inputOffset = startOffset;

    for (let i = 0; i < outLen; i++) {
        let remaining = ratio;
        let sum = 0;
        let sumWeight = 0;

        while (remaining > 0 && inputIndex < input.length) {
            const available = 1 - inputOffset;
            const take = remaining < available ? remaining : available;
            const sample = input[inputIndex] ?? 0;
            sum += sample * take;
            sumWeight += take;
            remaining -= take;
            inputOffset += take;

            if (inputOffset >= 1) {
                inputIndex += 1;
                inputOffset = 0;
            }
        }

        const avg = sumWeight > 0 ? (sum / sumWeight) : 0;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
    }
    return { samples: out, consumedInput: inputIndex, consumedOffset: inputOffset };
}

// ---------------------------------------------------------------------------
// PcmCapture class
// ---------------------------------------------------------------------------

class PcmCaptureClass {
    /** @type {undefined} */
    __brand = undefined;

    /** @type {AudioContext} */
    _audioContext;
    /** @type {MediaStreamAudioSourceNode} */
    _sourceNode;
    /** @type {AudioWorkletNode | ScriptProcessorNode | null} */
    _captureNode = null;
    /** @type {GainNode | null} */
    _silentGain = null;
    /** @type {number} */
    _sourceSampleRate;
    /** @type {Int16Array[]} */
    _bufferChunks = [];
    /** @type {number} */
    _totalSamples = 0;
    /**
     * Leftover Float32 input samples from the last _addSamples call that were
     * not consumed by downsample() because the block size is not an exact
     * multiple of the resampling ratio.  Prepended to the next callback to
     * prevent cumulative sample drift.
     * @type {Float32Array}
     */
    _resampleRemainder = new Float32Array(0);
    /** @type {number} */
    _resampleInputOffset = 0;
    /** @type {boolean} */
    _isRecording = true;

    /**
     * @param {AudioContext} audioContext
     * @param {MediaStreamAudioSourceNode} sourceNode
     */
    constructor(audioContext, sourceNode) {
        if (this.__brand !== undefined) {
            throw new Error("PcmCaptureClass is a nominal type");
        }
        this._audioContext = audioContext;
        this._sourceNode = sourceNode;
        this._sourceSampleRate = audioContext.sampleRate;
    }

    /**
     * Attach the capture node to the audio graph.
     * Tries AudioWorklet first; falls back to ScriptProcessorNode.
     * Returns true if a capture node was successfully attached, false otherwise.
     *
     * Returns false without attaching anything when the AudioContext sample rate
     * is below TARGET_SAMPLE_RATE — in that case the WAV header sampleRate would
     * not match the actual sample data (no upsampling is performed).
     * @returns {Promise<boolean>}
     */
    async setup() {
        if (this._sourceSampleRate < TARGET_SAMPLE_RATE) {
            return false;
        }
        if (this._audioContext.audioWorklet) {
            try {
                await this._setupWorklet();
                return true;
            } catch {
                // Fall through to ScriptProcessorNode.
            }
        }
        return this._setupScriptProcessor();
    }

    /** @returns {Promise<void>} */
    async _setupWorklet() {
        const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        try {
            await this._audioContext.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        const workletNode = new AudioWorkletNode(this._audioContext, WORKLET_PROCESSOR_NAME);
        workletNode.port.onmessage = (e) => {
            if (e.data instanceof Float32Array) {
                this._addSamples(e.data);
            }
        };
        // Connect source → worklet → silent gain → destination.
        // The downstream connection to destination is required to keep the
        // worklet node in the rendering graph; without it some browsers may
        // garbage-collect or suspend the node, stopping PCM delivery.
        const silent = this._audioContext.createGain();
        silent.gain.value = 0;
        silent.connect(this._audioContext.destination);
        this._sourceNode.connect(workletNode);
        workletNode.connect(silent);
        this._captureNode = workletNode;
        this._silentGain = silent;
    }

    /** @returns {boolean} */
    _setupScriptProcessor() {
        if (typeof this._audioContext.createScriptProcessor !== "function") {
            return false;
        }
        try {
            const node = this._audioContext.createScriptProcessor(4096, 1, 1);
            node.onaudioprocess = (e) => {
                const channelData = e.inputBuffer.getChannelData(0);
                this._addSamples(channelData);
            };
            // Connect source → node → silent gain → destination.
            // Without the destination connection onaudioprocess may not fire.
            const silent = this._audioContext.createGain();
            silent.gain.value = 0;
            silent.connect(this._audioContext.destination);
            this._sourceNode.connect(node);
            node.connect(silent);
            this._captureNode = node;
            this._silentGain = silent;
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @param {Float32Array} float32Samples
     */
    _addSamples(float32Samples) {
        if (!this._isRecording) {
            return;
        }
        // Prepend leftover input samples from the previous callback to prevent
        // cumulative drift when the audio block size (e.g. 128 frames) is not
        // an exact multiple of the resampling ratio (e.g. 3× for 48→16 kHz).
        let input = float32Samples;
        if (this._resampleRemainder.length > 0) {
            const merged = new Float32Array(this._resampleRemainder.length + float32Samples.length);
            merged.set(this._resampleRemainder, 0);
            merged.set(float32Samples, this._resampleRemainder.length);
            input = merged;
            this._resampleRemainder = new Float32Array(0);
        }
        const downsampled = downsample(
            input,
            this._sourceSampleRate,
            TARGET_SAMPLE_RATE,
            this._resampleInputOffset
        );
        const int16 = downsampled.samples;
        // Save any unconsumed input frames for the next callback (downsampling only).
        if (this._sourceSampleRate > TARGET_SAMPLE_RATE) {
            this._resampleInputOffset = downsampled.consumedOffset;
            if (downsampled.consumedInput < input.length) {
                this._resampleRemainder = input.slice(downsampled.consumedInput);
            }
        }
        if (int16.length > 0) {
            this._bufferChunks.push(int16);
            this._totalSamples += int16.length;
        }
    }

    /**
     * Pause PCM accumulation (called when MediaRecorder is paused).
     * Accumulated samples since the last drain are discarded so that
     * paused audio does not contaminate the next analysis window.
     */
    pause() {
        this._isRecording = false;
        // Discard samples accumulated between last drain and this pause.
        this._bufferChunks = [];
        this._totalSamples = 0;
        this._resampleRemainder = new Float32Array(0);
        this._resampleInputOffset = 0;
    }

    /**
     * Resume PCM accumulation (called when MediaRecorder resumes).
     */
    resume() {
        this._isRecording = true;
    }

    /**
     * Drain accumulated PCM samples for a given active duration and return
     * raw PCM bytes with format metadata.  Returns null when no samples are
     * available.
     *
     * The number of samples drained is clamped to the expected count based
     * on `durationMs` at the target sample rate; any excess is kept for the
     * next call.
     *
     * @param {number} durationMs - Active recording duration in milliseconds.
     * @returns {{ pcmBytes: ArrayBuffer, sampleRateHz: number, channels: number, bitDepth: number } | null}
     */
    drainPcm(durationMs) {
        if (this._totalSamples === 0) {
            return null;
        }

        // Gather all accumulated samples into a flat Int16Array.
        const all = new Int16Array(this._totalSamples);
        let offset = 0;
        for (const chunk of this._bufferChunks) {
            all.set(chunk, offset);
            offset += chunk.length;
        }
        this._bufferChunks = [];
        this._totalSamples = 0;

        // Drain at most the expected number of samples for this fragment duration.
        // Use floor to avoid borrowing a sample from the next fragment when
        // durationMs includes fractional milliseconds.
        const expectedSamples = Math.floor((TARGET_SAMPLE_RATE * durationMs) / 1000);
        const drainCount = Math.min(expectedSamples, all.length);

        // Keep any excess samples for the next fragment using an independent copy.
        if (drainCount < all.length) {
            this._bufferChunks = [all.slice(drainCount)];
            this._totalSamples = all.length - drainCount;
        }

        if (drainCount === 0) {
            return null;
        }

        // Return a copy of just the drained PCM bytes (raw Int16 little-endian).
        const pcmBytes = all.buffer.slice(0, drainCount * 2);
        return { pcmBytes, sampleRateHz: TARGET_SAMPLE_RATE, channels: 1, bitDepth: 16 };
    }

    /**
     * Disconnect the capture node and release resources.
     */
    close() {
        if (this._captureNode) {
            try {
                this._sourceNode.disconnect(this._captureNode);
            } catch {
                // Ignore errors when the graph is already torn down.
            }
            if (typeof AudioWorkletNode !== "undefined" &&
                this._captureNode instanceof AudioWorkletNode) {
                try {
                    this._captureNode.disconnect();
                    this._captureNode.port.close();
                } catch {
                    // Ignore.
                }
            }
            this._captureNode = null;
        }
        if (this._silentGain) {
            try {
                this._silentGain.disconnect();
            } catch {
                // Ignore.
            }
            this._silentGain = null;
        }
        this._bufferChunks = [];
        this._totalSamples = 0;
        this._resampleRemainder = new Float32Array(0);
        this._resampleInputOffset = 0;
    }
}

/**
 * Create and set up a PCM capture node attached to an existing audio graph.
 * Returns null when neither AudioWorklet nor ScriptProcessorNode is available
 * in the current browser environment.
 *
 * @param {AudioContext} audioContext
 * @param {MediaStreamAudioSourceNode} sourceNode
 * @returns {Promise<PcmCaptureClass | null>}
 */
export async function makePcmCapture(audioContext, sourceNode) {
    try {
        const capture = new PcmCaptureClass(audioContext, sourceNode);
        const attached = await capture.setup();
        return attached ? capture : null;
    } catch {
        return null;
    }
}

/** @param {unknown} object @returns {object is PcmCaptureClass} */
export function isPcmCapture(object) {
    return object instanceof PcmCaptureClass;
}

export { downsample, TARGET_SAMPLE_RATE };
