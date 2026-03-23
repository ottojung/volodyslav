/**
 * Collects raw audio fragments and emits timed audio chunks on a nominal
 * 5-minute window grid with 10-second overlaps between consecutive windows.
 *
 * CHUNK_DURATION_MS and OVERLAP_MS define this emission grid, but the
 * actual `start` and `end` of each emitted AudioChunk are expanded to the
 * minimum and maximum timestamps of the fragments it contains. This means a
 * single AudioChunk can cover more than CHUNK_DURATION_MS of audio, and the
 * effective overlap with the previous chunk can be larger than OVERLAP_MS
 * when fragments span multiple nominal windows.
 *
 * API consumers should treat CHUNK_DURATION_MS and OVERLAP_MS as describing
 * the intended windowing configuration, not strict upper bounds on chunk
 * duration or inter-chunk overlap.
 *
 * @module audio_chunk_collector
 */

import { combineChunks } from "./recorder_helpers.js";

/**
 * Milliseconds elapsed since the recording started.
 * @typedef {number} RelativeTimestamp
 */

/**
 * A timed audio segment produced by the chunk collector.
 * @typedef {object} AudioChunk
 * @property {RelativeTimestamp} start - Start time in ms since recording began.
 * @property {RelativeTimestamp} end   - End time in ms since recording began.
 * @property {Blob} data               - Combined audio Blob for this window.
 */

/** @typedef {(chunk: AudioChunk) => void} OnAudioChunk */

/**
 * @typedef {object} Fragment
 * @property {RelativeTimestamp} start
 * @property {RelativeTimestamp} end
 * @property {Blob} data
 */

/** Duration of each emitted chunk window (5 minutes). */
export const CHUNK_DURATION_MS = 5 * 60 * 1000;

/** Overlap between consecutive chunk windows (10 seconds). */
export const OVERLAP_MS = 10 * 1000;

class AudioChunkCollectorClass {
    /** @type {undefined} */
    __brand = undefined;

    /** @type {Fragment[]} */
    _fragments = [];

    /** @type {RelativeTimestamp} */
    _nextWindowStart = 0;

    /** @type {RelativeTimestamp} */
    _nextEmitAt = CHUNK_DURATION_MS;

    /** @type {string} */
    _mimeType = "";

    /** @type {OnAudioChunk} */
    _onChunk;

    /**
     * @param {OnAudioChunk} onChunk
     */
    constructor(onChunk) {
        if (this.__brand !== undefined) {
            throw new Error("AudioChunkCollectorClass is a nominal type");
        }
        this._onChunk = onChunk;
    }

    /**
     * Feed a raw audio fragment into the collector.
     * Emits completed AudioChunks via the onChunk callback as windows fill up.
     * @param {Blob} data
     * @param {RelativeTimestamp} startMs
     * @param {RelativeTimestamp} endMs
     */
    push(data, startMs, endMs) {
        if (data.type) {
            this._mimeType = data.type;
        }
        this._fragments.push({ start: startMs, end: endMs, data });

        while (endMs >= this._nextEmitAt) {
            const windowStart = this._nextWindowStart;
            const windowEnd = this._nextEmitAt;

            const windowFragments = this._fragments.filter(
                (f) => f.end > windowStart && f.start < windowEnd
            );

            // Advance window based on fixed grid to maintain proper overlap structure.
            this._nextWindowStart = windowEnd - OVERLAP_MS;
            this._nextEmitAt = this._nextWindowStart + CHUNK_DURATION_MS;

            // Skip emission when no fragments overlap this window to avoid emitting
            // empty or misleading chunks (e.g. when the first fragment arrives long
            // after recording start, or after a gap in the timeline).
            if (windowFragments.length === 0) {
                continue;
            }

            // Align declared bounds to actual fragment coverage so that AudioChunk.data
            // does not contain audio outside the declared [start, end] range.
            const chunkStart = Math.min(...windowFragments.map((f) => f.start));
            const chunkEnd = Math.max(...windowFragments.map((f) => f.end));

            const chunkData = combineChunks(
                windowFragments.map((f) => f.data),
                this._mimeType
            );

            this._onChunk({ start: chunkStart, end: chunkEnd, data: chunkData });

            // Prune fragments that are entirely before the new window start.
            this._fragments = this._fragments.filter(
                (f) => f.end > this._nextWindowStart
            );
        }
    }

    /**
     * Reset collector state for a new recording session.
     */
    reset() {
        this._fragments = [];
        this._nextWindowStart = 0;
        this._nextEmitAt = CHUNK_DURATION_MS;
        this._mimeType = "";
    }
}

/**
 * Create a new audio chunk collector.
 * @param {OnAudioChunk} onChunk - Called whenever a full chunk is ready.
 * @returns {AudioChunkCollectorClass}
 */
export function makeAudioChunkCollector(onChunk) {
    return new AudioChunkCollectorClass(onChunk);
}

/**
 * @param {unknown} object
 * @returns {object is AudioChunkCollectorClass}
 */
export function isAudioChunkCollector(object) {
    return object instanceof AudioChunkCollectorClass;
}

/**
 * Return the initial (empty) audio chunks array.
 * @returns {AudioChunk[]}
 */
export function initialAudioChunks() {
    return [];
}
