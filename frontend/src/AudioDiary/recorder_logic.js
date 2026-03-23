/**
 * Recorder logic for audio diary.
 * @module recorder_logic
 */
import { chooseMimeType, combineChunks, mediaRecorderErrorMessage } from "./recorder_helpers.js";
import { stopStream, stopAudioGraph } from "./recorder_cleanup_helpers.js";
/** @typedef {import("./audio_helpers.js").RecorderState} RecorderState */
const FRAGMENT_MS = 10 * 1000; // 10-second fragments for chunk collection
/**
 * @typedef {object} RecorderCallbacks
 * @property {(state: RecorderState) => void} onStateChange
 * @property {(blob: Blob) => void} onStop
 * @property {(message: string) => void} onError
 * @property {(analyser: AnalyserNode | null) => void} onAnalyser
 * @property {(chunk: Blob, startMs: number, endMs: number) => void} [onChunk] - called with each fragment and its relative timestamps
 */
class RecorderClass {
    /** @type {undefined} */
    __brand = undefined;
    /** @type {MediaRecorder | null} */
    _mediaRecorder = null;
    /** @type {Blob[]} */
    _chunks = [];
    /** @type {string} */
    _mimeType = "";
    /** @type {RecorderState} */
    _state = "idle";
    /** @type {RecorderCallbacks} */
    _callbacks;
    /** @type {AudioContext | null} */
    _audioContext = null;
    /** @type {MediaStreamAudioSourceNode | null} */
    _sourceNode = null;
    /** @type {AnalyserNode | null} */
    _analyserNode = null;
    /** @type {MediaStream | null} */
    _stream = null;
    /** @type {Array<() => void>} */
    _requestDataResolvers = [];
    /** @type {number} */
    _recordingStartMs = 0;
    /** @type {number} */
    _totalPausedMs = 0;
    /** @type {number} */
    _pauseStartMs = 0;
    /** @type {number} */
    _fragmentStartMs = 0;
    /** @param {RecorderCallbacks} callbacks */
    constructor(callbacks) {
        if (this.__brand !== undefined) {
            throw new Error("RecorderClass is a nominal type");
        }
        this._callbacks = callbacks;
    }
    /** @returns {RecorderState} */
    get state() {
        return this._state;
    }
    /** @param {RecorderState} next */
    _setState(next) {
        this._state = next;
        this._callbacks.onStateChange(next);
    }
    /**
     * @returns {Promise<void>}
     */
    async start() {
        if (this._state !== "idle") {
            return;
        }
        if (typeof MediaRecorder === "undefined") {
            this._callbacks.onError(
                "MediaRecorder is not supported in this browser."
            );
            return;
        }
        if (
            typeof navigator === "undefined" ||
            !navigator.mediaDevices ||
            typeof navigator.mediaDevices.getUserMedia !== "function"
        ) {
            this._callbacks.onError(
                "Microphone access is not supported in this browser."
            );
            return;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            const message =
                err instanceof Error ? err.message : String(err);
            this._callbacks.onError(
                `Microphone access denied or unavailable: ${message}`
            );
            return;
        }
        this._stream = stream;
        try {
            const AudioContextCtor =
                window.AudioContext ||
                // @ts-expect-error - vendor prefix
                window.webkitAudioContext;
            if (AudioContextCtor) {
                this._audioContext = new AudioContextCtor();
                this._sourceNode =
                    this._audioContext.createMediaStreamSource(stream);
                this._analyserNode = this._audioContext.createAnalyser();
                this._analyserNode.fftSize = 256;
                this._sourceNode.connect(this._analyserNode);
                this._callbacks.onAnalyser(this._analyserNode);
            }
        } catch {
            this._stopAudioGraph();
            this._callbacks.onAnalyser(null);
        }
        this._mimeType = chooseMimeType();
        this._chunks = [];
        this._recordingStartMs = performance.now();
        this._totalPausedMs = 0;
        this._pauseStartMs = 0;
        this._fragmentStartMs = 0;
        try {
            const options = this._mimeType ? { mimeType: this._mimeType } : {};
            this._mediaRecorder = new MediaRecorder(stream, options);
        } catch (err) {
            const message =
                err instanceof Error ? err.message : String(err);
            this._callbacks.onError(
                `MediaRecorder is not supported in this browser: ${message}`
            );
            this._stopStream();
            this._stopAudioGraph();
            this._callbacks.onAnalyser(null);
            return;
        }
        this._mediaRecorder.ondataavailable = (e) => {
            if (this._requestDataResolvers.length > 0) {
                const resolvers = this._requestDataResolvers;
                this._requestDataResolvers = [];
                resolvers.forEach((resolve) => resolve());
            }
            if (e.data && e.data.size > 0) {
                const fragStart = this._fragmentStartMs;
                // Compute active (non-paused) elapsed ms as the fragment's end time.
                const now = performance.now();
                const ongoingPausedMs =
                    this._state === "paused"
                        ? now - this._pauseStartMs
                        : 0;
                const fragEnd =
                    now - this._recordingStartMs - this._totalPausedMs - ongoingPausedMs;
                this._fragmentStartMs = fragEnd;
                this._chunks.push(e.data);
                if (this._callbacks.onChunk) {
                    this._callbacks.onChunk(e.data, fragStart, fragEnd);
                }
            }
        };
        this._mediaRecorder.onstop = () => {
            this._stopStream();
            const blob = combineChunks(this._chunks, this._mimeType);
            this._chunks = [];
            this._mediaRecorder = null;
            if (this._requestDataResolvers.length > 0) {
                const resolvers = this._requestDataResolvers;
                this._requestDataResolvers = [];
                resolvers.forEach((resolve) => resolve());
            }
            this._stopAudioGraph();
            this._callbacks.onAnalyser(null);
            if (this._state === "recording" || this._state === "paused") {
                this._setState("stopped");
            }
            this._callbacks.onStop(blob);
        };
        this._mediaRecorder.onerror = (e) => {
            const message = mediaRecorderErrorMessage(e);
            this._callbacks.onError(`Recording error: ${message}`);
            if (this._mediaRecorder) {
                this._mediaRecorder.ondataavailable = null;
                this._mediaRecorder.onstop = null;
                this._mediaRecorder.onerror = null;
                this._mediaRecorder = null;
            }
            if (this._requestDataResolvers.length > 0) {
                const resolvers = this._requestDataResolvers;
                this._requestDataResolvers = [];
                resolvers.forEach((resolve) => resolve());
            }
            this._cleanupResources();
        };
        this._mediaRecorder.start(FRAGMENT_MS);
        this._setState("recording");
    }
    pause() {
        if (this._state !== "recording" || !this._mediaRecorder) {
            return;
        }
        this._pauseStartMs = performance.now();
        this._mediaRecorder.pause();
        this._setState("paused");
    }
    resume() {
        if (this._state !== "paused" || !this._mediaRecorder) {
            return;
        }
        if (this._pauseStartMs > 0) {
            this._totalPausedMs += performance.now() - this._pauseStartMs;
            this._pauseStartMs = 0;
        }
        this._mediaRecorder.resume();
        this._setState("recording");
    }
    /** @returns {Promise<void>} */
    requestData() {
        if (
            this._mediaRecorder &&
            (this._state === "recording" || this._state === "paused")
        ) {
            const mediaRecorder = this._mediaRecorder;
            return new Promise((resolve) => {
                this._requestDataResolvers.push(resolve);
                try {
                    mediaRecorder.requestData();
                } catch {
                    const resolvers = this._requestDataResolvers;
                    this._requestDataResolvers = [];
                    resolvers.forEach((nextResolve) => nextResolve());
                }
            });
        }
        return Promise.resolve();
    }
    stop() {
        if (
            (this._state !== "recording" && this._state !== "paused") ||
            !this._mediaRecorder
        ) {
            return;
        }
        this._mediaRecorder.stop();
    }
    discard() {
        if (this._mediaRecorder) {
            this._mediaRecorder.ondataavailable = null;
            this._mediaRecorder.onstop = null;
            this._mediaRecorder.onerror = null;
            try {
                if (
                    this._mediaRecorder.state === "recording" ||
                    this._mediaRecorder.state === "paused"
                ) {
                    this._mediaRecorder.stop();
                }
            } catch {
                // Ignore errors during discard
            }
            this._mediaRecorder = null;
        }
        if (this._requestDataResolvers.length > 0) {
            const resolvers = this._requestDataResolvers;
            this._requestDataResolvers = [];
            resolvers.forEach((resolve) => resolve());
        }
        this._cleanupResources();
    }
    _cleanupResources() {
        this._stopStream();
        this._stopAudioGraph();
        this._callbacks.onAnalyser(null);
        this._chunks = [];
        this._setState("idle");
    }
    _stopStream() {
        this._stream = stopStream(this._stream);
    }
    _stopAudioGraph() {
        const next = stopAudioGraph(this._sourceNode, this._audioContext);
        this._sourceNode = next.sourceNode;
        this._audioContext = next.audioContext;
        this._analyserNode = next.analyserNode;
    }
}
/**
 * Create a new recorder instance.
 * @param {RecorderCallbacks} callbacks
 * @returns {RecorderClass}
 */
export function makeRecorder(callbacks) {
    return new RecorderClass(callbacks);
}
/**
 * @param {unknown} object
 * @returns {object is RecorderClass}
 */
export function isRecorder(object) {
    return object instanceof RecorderClass;
}
