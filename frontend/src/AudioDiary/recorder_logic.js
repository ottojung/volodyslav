/**
 * Recorder logic for audio diary.
 *
 * Wraps MediaRecorder with chunk-based collection (5-minute chunks) and
 * provides a simple state machine: idle → recording → paused → stopped.
 *
 * Helper utilities (chooseMimeType, combineChunks) live in recorder_helpers.js.
 *
 * @module recorder_logic
 */

import { chooseMimeType, combineChunks } from "./recorder_helpers.js";

/** @typedef {'idle' | 'recording' | 'paused' | 'stopped'} RecorderState */

const CHUNK_INTERVAL_MS = 5 * 60 * 1000; // 5-minute chunks

/**
 * @typedef {object} RecorderCallbacks
 * @property {(state: RecorderState) => void} onStateChange
 * @property {(blob: Blob) => void} onStop
 * @property {(message: string) => void} onError
 * @property {(analyser: AnalyserNode | null) => void} onAnalyser
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

    /**
     * @param {RecorderCallbacks} callbacks
     */
    constructor(callbacks) {
        if (this.__brand !== undefined) {
            throw new Error("RecorderClass is a nominal type");
        }
        this._callbacks = callbacks;
    }

    /**
     * @returns {RecorderState}
     */
    get state() {
        return this._state;
    }

    /**
     * @param {RecorderState} next
     */
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

        // Set up Web Audio analyser for visualisation
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
            // Visualisation is optional; ignore errors here.
        }

        this._mimeType = chooseMimeType();
        this._chunks = [];

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
            if (e.data && e.data.size > 0) {
                this._chunks.push(e.data);
            }
        };

        this._mediaRecorder.onstop = () => {
            this._stopStream();
            const blob = combineChunks(this._chunks, this._mimeType);
            this._mediaRecorder = null;
            this._stopAudioGraph();
            this._callbacks.onAnalyser(null);
            if (this._state === "recording" || this._state === "paused") {
                this._setState("stopped");
            }
            this._callbacks.onStop(blob);
        };

        this._mediaRecorder.onerror = (e) => {
            const message =
                e instanceof ErrorEvent
                    ? e.message
                    : "Unknown MediaRecorder error";
            this._callbacks.onError(`Recording error: ${message}`);
        };

        this._mediaRecorder.start(CHUNK_INTERVAL_MS);
        this._setState("recording");
    }

    pause() {
        if (this._state !== "recording" || !this._mediaRecorder) {
            return;
        }
        this._mediaRecorder.pause();
        this._setState("paused");
    }

    resume() {
        if (this._state !== "paused" || !this._mediaRecorder) {
            return;
        }
        this._mediaRecorder.resume();
        this._setState("recording");
    }

    stop() {
        if (
            (this._state !== "recording" && this._state !== "paused") ||
            !this._mediaRecorder
        ) {
            return;
        }
        this._mediaRecorder.stop();
        this._setState("stopped");
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
        this._stopStream();
        this._stopAudioGraph();
        this._callbacks.onAnalyser(null);
        this._chunks = [];
        this._setState("idle");
    }

    _stopStream() {
        if (this._stream) {
            this._stream.getTracks().forEach((t) => t.stop());
            this._stream = null;
        }
    }

    _stopAudioGraph() {
        try {
            if (this._sourceNode) {
                this._sourceNode.disconnect();
                this._sourceNode = null;
            }
            if (this._audioContext) {
                void this._audioContext.close();
                this._audioContext = null;
            }
        } catch {
            // Ignore errors during cleanup
        }
        this._analyserNode = null;
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
