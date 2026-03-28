/**
 * Parallel PCM capture for live-diary analysis audio.
 *
 * Captures audio from an existing AudioContext + MediaStreamSource in
 * parallel with MediaRecorder, producing mono PCM16 fragments at a fixed
 * 16 kHz sample rate.  Each fragment can then be wrapped as a WAV file
 * and uploaded alongside the archival WebM chunk for transcription-based
 * live questioning.
 *
 * Implementation note — capture node choice:
 *   Primary path:  AudioWorkletProcessor.  Runs off the main thread and
 *     avoids the deprecated ScriptProcessorNode.
 *   Fallback path: ScriptProcessorNode.  Used when AudioWorklet is not
 *     available (older browsers).  If neither API is available, PCM
 *     capture silently degrades to a no-op; analysis chunks will be null.
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
// WAV builder (browser-side, ArrayBuffer-based)
// ---------------------------------------------------------------------------

/**
 * Build a WAV-wrapped Blob from an Int16 PCM sample array.
 * @param {Int16Array} samples - Mono PCM16 samples.
 * @param {number} sampleRate
 * @returns {Blob}
 */
function buildWavBlob(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * 2;

    const header = new ArrayBuffer(44);
    const v = new DataView(header);

    // "RIFF"
    v.setUint8(0, 0x52); v.setUint8(1, 0x49); v.setUint8(2, 0x46); v.setUint8(3, 0x46);
    v.setUint32(4, 36 + dataSize, true);
    // "WAVE"
    v.setUint8(8, 0x57); v.setUint8(9, 0x41); v.setUint8(10, 0x56); v.setUint8(11, 0x45);
    // "fmt "
    v.setUint8(12, 0x66); v.setUint8(13, 0x6d); v.setUint8(14, 0x74); v.setUint8(15, 0x20);
    v.setUint32(16, 16, true);            // fmt chunk size
    v.setUint16(20, 1, true);             // PCM format
    v.setUint16(22, numChannels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bitsPerSample, true);
    // "data"
    v.setUint8(36, 0x64); v.setUint8(37, 0x61); v.setUint8(38, 0x74); v.setUint8(39, 0x61);
    v.setUint32(40, dataSize, true);

    // Create a fresh copy of samples so the Blob owns its own buffer.
    const pcmCopy = new Int16Array(samples);
    return new Blob([header, pcmCopy.buffer], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Downsampling helper
// ---------------------------------------------------------------------------

/**
 * Downsample a Float32 mono channel to a target sample rate, returning Int16.
 * Uses linear averaging over each output sample's contributing input interval.
 *
 * @param {Float32Array} input - Input samples at `fromRate` Hz.
 * @param {number} fromRate - Input sample rate.
 * @param {number} toRate - Output sample rate.
 * @returns {Int16Array}
 */
function downsample(input, fromRate, toRate) {
    if (fromRate === toRate) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const sample = input[i] ?? 0;
            out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
        }
        return out;
    }
    const ratio = fromRate / toRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.ceil((i + 1) * ratio), input.length);
        let sum = 0;
        for (let j = start; j < end; j++) {
            sum += input[j] ?? 0;
        }
        const avg = sum / (end - start);
        out[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
    }
    return out;
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
    /** @type {number} */
    _sourceSampleRate;
    /** @type {Int16Array[]} */
    _bufferChunks = [];
    /** @type {number} */
    _totalSamples = 0;
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
     * Resolves without error even when neither API is available.
     * @returns {Promise<void>}
     */
    async setup() {
        if (this._audioContext.audioWorklet) {
            try {
                await this._setupWorklet();
                return;
            } catch {
                // Fall through to ScriptProcessorNode.
            }
        }
        this._setupScriptProcessor();
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
        this._sourceNode.connect(workletNode);
        this._captureNode = workletNode;
    }

    _setupScriptProcessor() {
        if (typeof this._audioContext.createScriptProcessor !== "function") {
            return;
        }
        try {
            const node = this._audioContext.createScriptProcessor(4096, 1, 1);
            node.onaudioprocess = (e) => {
                const channelData = e.inputBuffer.getChannelData(0);
                this._addSamples(channelData);
            };
            this._sourceNode.connect(node);
            // Connect output to a silent gain node so the graph stays active.
            const silent = this._audioContext.createGain();
            silent.gain.value = 0;
            node.connect(silent);
            this._captureNode = node;
        } catch {
            // PCM capture unavailable.
        }
    }

    /**
     * @param {Float32Array} float32Samples
     */
    _addSamples(float32Samples) {
        if (!this._isRecording) {
            return;
        }
        const int16 = downsample(float32Samples, this._sourceSampleRate, TARGET_SAMPLE_RATE);
        this._bufferChunks.push(int16);
        this._totalSamples += int16.length;
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
    }

    /**
     * Resume PCM accumulation (called when MediaRecorder resumes).
     */
    resume() {
        this._isRecording = true;
    }

    /**
     * Drain accumulated PCM samples for a given active duration and return
     * a WAV-wrapped Blob.  Returns null when no samples are available.
     *
     * The number of samples drained is clamped to the expected count based
     * on `durationMs` at the target sample rate; any excess is kept for the
     * next call.
     *
     * @param {number} durationMs - Active recording duration in milliseconds.
     * @returns {Blob | null}
     */
    drainWav(durationMs) {
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
        const expectedSamples = Math.round((TARGET_SAMPLE_RATE * durationMs) / 1000);
        const drainCount = Math.min(expectedSamples, all.length);

        // Keep any excess samples for the next fragment using an independent copy.
        if (drainCount < all.length) {
            this._bufferChunks = [all.slice(drainCount)];
            this._totalSamples = all.length - drainCount;
        }

        const drained = new Int16Array(all.buffer, 0, drainCount);
        return buildWavBlob(drained, TARGET_SAMPLE_RATE);
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
            if (this._captureNode instanceof AudioWorkletNode) {
                try {
                    this._captureNode.disconnect();
                    this._captureNode.port.close();
                } catch {
                    // Ignore.
                }
            }
            this._captureNode = null;
        }
        this._bufferChunks = [];
        this._totalSamples = 0;
    }
}

/**
 * Create and set up a PCM capture node attached to an existing audio graph.
 * Returns null when the required browser APIs are not available.
 *
 * @param {AudioContext} audioContext
 * @param {MediaStreamAudioSourceNode} sourceNode
 * @returns {Promise<PcmCaptureClass | null>}
 */
export async function makePcmCapture(audioContext, sourceNode) {
    try {
        const capture = new PcmCaptureClass(audioContext, sourceNode);
        await capture.setup();
        return capture;
    } catch {
        return null;
    }
}

/** @param {unknown} object @returns {object is PcmCaptureClass} */
export function isPcmCapture(object) {
    return object instanceof PcmCaptureClass;
}

export { buildWavBlob, downsample, TARGET_SAMPLE_RATE };
