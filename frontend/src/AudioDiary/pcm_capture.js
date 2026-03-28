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
 *     capture degrades to a no-op and makePcmCapture returns null.
 *
 * Implementation note — WAV encoding:
 *   buildWavBlob() writes the 44-byte RIFF/PCM header directly into an
 *   ArrayBuffer using DataView and copies the raw Int16 bytes with a
 *   Uint8Array.set() — no per-sample boxing required.  This matters because
 *   each 10-second fragment at 16 kHz holds ~160 000 samples; libraries
 *   that require a plain JS Number[] (e.g. wavefile.fromScratch()) would
 *   allocate ~160 000 Number objects per fragment, creating significant GC
 *   pressure.  The manual approach has zero per-sample allocations.
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
// WAV builder (browser-side)
// ---------------------------------------------------------------------------

/**
 * Build a WAV-wrapped Blob from an Int16 PCM sample array.
 * Writes a 44-byte standard PCM header directly into an ArrayBuffer and
 * copies the raw sample bytes after it — no per-sample boxing required.
 *
 * @param {Int16Array} samples - Mono PCM16 samples.
 * @param {number} sampleRate
 * @returns {Blob}
 */
function buildWavBlob(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = samples.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF descriptor
    view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
    view.setUint32(4, 36 + dataSize, true);
    view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
    // "fmt " sub-chunk
    view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
    view.setUint32(16, 16, true);                                        // Subchunk1Size
    view.setUint16(20, 1, true);                                         // AudioFormat = PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
    view.setUint16(32, numChannels * bytesPerSample, true);              // BlockAlign
    view.setUint16(34, bitsPerSample, true);
    // "data" sub-chunk
    view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
    view.setUint32(40, dataSize, true);

    // Copy raw PCM bytes after the header.
    new Uint8Array(buffer, 44).set(new Uint8Array(samples.buffer, samples.byteOffset, dataSize));

    return new Blob([buffer], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Downsampling helper
// ---------------------------------------------------------------------------

/**
 * Downsample a Float32 mono channel to a target sample rate, returning Int16.
 * Uses linear averaging over each output sample's contributing input interval.
 *
 * When `fromRate` is less than or equal to `toRate` (no downsampling needed)
 * each input sample is converted directly to Int16 without averaging.
 *
 * @param {Float32Array} input - Input samples at `fromRate` Hz.
 * @param {number} fromRate - Input sample rate.
 * @param {number} toRate - Output sample rate.
 * @returns {Int16Array}
 */
function downsample(input, fromRate, toRate) {
    if (fromRate <= toRate) {
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
        const int16 = downsample(input, this._sourceSampleRate, TARGET_SAMPLE_RATE);
        // Save any unconsumed input frames for the next callback (downsampling only).
        if (this._sourceSampleRate > TARGET_SAMPLE_RATE && int16.length > 0) {
            const consumed = Math.floor(int16.length * (this._sourceSampleRate / TARGET_SAMPLE_RATE));
            if (consumed < input.length) {
                this._resampleRemainder = input.slice(consumed);
            }
        }
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
        this._resampleRemainder = new Float32Array(0);
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

export { buildWavBlob, downsample, TARGET_SAMPLE_RATE };

