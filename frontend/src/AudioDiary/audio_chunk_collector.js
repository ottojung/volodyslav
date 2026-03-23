/**
 * Collects raw audio fragments and emits timed 5-minute chunks with
 * 10-second overlaps between consecutive chunks.
 *
 * Each emitted AudioChunk covers CHUNK_DURATION_MS of audio and overlaps
 * the previous chunk by OVERLAP_MS at the start.
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

            const chunkData = combineChunks(
                windowFragments.map((f) => f.data),
                this._mimeType
            );

            this._onChunk({ start: windowStart, end: windowEnd, data: chunkData });

            this._nextWindowStart = windowEnd - OVERLAP_MS;
            this._nextEmitAt = this._nextWindowStart + CHUNK_DURATION_MS;

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
