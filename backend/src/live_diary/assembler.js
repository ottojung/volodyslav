/**
 * Sample-accurate PCM assembler for the live diary pull pipeline.
 *
 * Assembles a contiguous PCM buffer covering a requested time window
 * [windowStartMs, windowEndMs] from a set of fragment descriptors.  Each
 * fragment supplies its timing (startMs, endMs) and a Buffer of raw 16-bit
 * signed little-endian PCM samples.
 *
 * Rules:
 *  - Fragments are ordered by (startMs, sequence).
 *  - Overlapping fragments are clipped to avoid double-counting samples.
 *  - Gaps within the window are filled with silence.
 *  - Partial edges are sliced to sample-frame accuracy.
 *
 * @module live_diary/assembler
 */

/**
 * @typedef {object} AssemblerFragment
 * @property {number} sequence
 * @property {number} startMs
 * @property {number} endMs
 * @property {Buffer} pcm - Raw 16-bit signed little-endian PCM samples.
 * @property {number} sampleRateHz
 * @property {number} channels
 * @property {number} bitDepth
 */

/**
 * @typedef {object} AssemblerInput
 * @property {AssemblerFragment[]} fragments - All available fragments (may extend beyond window).
 * @property {number} windowStartMs
 * @property {number} windowEndMs
 * @property {number} sampleRateHz - Expected format for all fragments.
 * @property {number} channels
 * @property {number} bitDepth
 */

/**
 * Error thrown when a fragment has an incompatible audio format.
 */
class AssemblerFormatMismatchError extends Error {
    /**
     * @param {string} message
     * @param {number} sequence
     */
    constructor(message, sequence) {
        super(message);
        this.name = "AssemblerFormatMismatchError";
        this.sequence = sequence;
    }
}

/**
 * Error thrown when a fragment has invalid timing (endMs <= startMs).
 */
class AssemblerInvalidFragmentError extends Error {
    /**
     * @param {string} message
     * @param {number} sequence
     */
    constructor(message, sequence) {
        super(message);
        this.name = "AssemblerInvalidFragmentError";
        this.sequence = sequence;
    }
}

/**
 * @param {AssemblerFormatMismatchError | AssemblerInvalidFragmentError | unknown} object
 * @returns {object is AssemblerFormatMismatchError}
 */
function isAssemblerFormatMismatchError(object) {
    return object instanceof AssemblerFormatMismatchError;
}

/**
 * @param {AssemblerFormatMismatchError | AssemblerInvalidFragmentError | unknown} object
 * @returns {object is AssemblerInvalidFragmentError}
 */
function isAssemblerInvalidFragmentError(object) {
    return object instanceof AssemblerInvalidFragmentError;
}

/**
 * Compute the byte size of one PCM frame (one sample per channel).
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {number}
 */
function frameSize(channels, bitDepth) {
    return channels * (bitDepth / 8);
}

/**
 * Convert a time offset in milliseconds (relative to a fragment's startMs) to
 * a byte offset within the fragment's PCM buffer.  The result is aligned down
 * to the nearest frame boundary.
 *
 * Use this for slice start offsets (rounding down ensures we don't skip audio
 * that starts slightly before the requested boundary).
 *
 * @param {number} relativeMs - Time offset from fragment start (may be negative = clamp to 0).
 * @param {number} sampleRateHz
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {number} byte offset (frame-aligned floor, clamped to [0, Infinity))
 */
function msToBytesAligned(relativeMs, sampleRateHz, channels, bitDepth) {
    if (relativeMs <= 0) return 0;
    const fs = frameSize(channels, bitDepth);
    const frames = Math.floor(relativeMs * sampleRateHz / 1000);
    return frames * fs;
}

/**
 * Convert a time offset in milliseconds (relative to a fragment's startMs) to
 * a byte offset within the fragment's PCM buffer.  The result is aligned UP
 * to the nearest frame boundary.
 *
 * Use this for slice end offsets so that audio at non-integer millisecond
 * boundaries is never truncated (the extra partial frame is included).
 *
 * @param {number} relativeMs - Time offset from fragment start (may be negative = clamp to 0).
 * @param {number} sampleRateHz
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {number} byte offset (frame-aligned ceil, clamped to [0, Infinity))
 */
function msToBytesAlignedCeil(relativeMs, sampleRateHz, channels, bitDepth) {
    if (relativeMs <= 0) return 0;
    const fs = frameSize(channels, bitDepth);
    const frames = Math.ceil(relativeMs * sampleRateHz / 1000);
    return frames * fs;
}

/**
 * Build a silent PCM buffer covering the given duration.
 * @param {number} durationMs
 * @param {number} sampleRateHz
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {Buffer}
 */
function silenceBuffer(durationMs, sampleRateHz, channels, bitDepth) {
    if (durationMs <= 0) return Buffer.alloc(0);
    const fs = frameSize(channels, bitDepth);
    const frames = Math.ceil(durationMs * sampleRateHz / 1000);
    return Buffer.alloc(frames * fs, 0);
}

/**
 * Assemble a PCM buffer for the time window [windowStartMs, windowEndMs].
 *
 * Fragments that overlap but have format mismatches (different sampleRateHz,
 * channels, or bitDepth) throw AssemblerFormatMismatchError.
 * Fragments with endMs <= startMs throw AssemblerInvalidFragmentError.
 *
 * @param {AssemblerInput} input
 * @returns {Buffer} Concatenated PCM for the requested window.
 */
function assemblePcm(input) {
    const { fragments, windowStartMs, windowEndMs, sampleRateHz, channels, bitDepth } = input;

    // Validate and filter to fragments that intersect the window.
    const intersecting = [];
    for (const frag of fragments) {
        if (frag.endMs <= frag.startMs) {
            throw new AssemblerInvalidFragmentError(
                `Fragment ${frag.sequence} has invalid duration: endMs (${frag.endMs}) <= startMs (${frag.startMs})`,
                frag.sequence
            );
        }
        // Only include fragments that intersect [windowStartMs, windowEndMs).
        if (frag.endMs <= windowStartMs || frag.startMs >= windowEndMs) {
            continue;
        }
        if (frag.sampleRateHz !== sampleRateHz || frag.channels !== channels || frag.bitDepth !== bitDepth) {
            throw new AssemblerFormatMismatchError(
                `Fragment ${frag.sequence} format mismatch: ` +
                `expected ${sampleRateHz}Hz/${channels}ch/${bitDepth}bit, ` +
                `got ${frag.sampleRateHz}Hz/${frag.channels}ch/${frag.bitDepth}bit`,
                frag.sequence
            );
        }
        intersecting.push(frag);
    }

    // Sort by (startMs, sequence).
    intersecting.sort((a, b) => a.startMs !== b.startMs ? a.startMs - b.startMs : a.sequence - b.sequence);

    const chunks = [];
    // coveredUntilMs tracks how far we have assembled output for within the window.
    let coveredUntilMs = windowStartMs;

    for (const frag of intersecting) {
        const fragStart = Math.max(frag.startMs, windowStartMs);
        const fragEnd = Math.min(frag.endMs, windowEndMs);

        if (fragStart >= fragEnd) continue;

        // Fill any gap before this fragment with silence.
        if (fragStart > coveredUntilMs) {
            chunks.push(silenceBuffer(fragStart - coveredUntilMs, sampleRateHz, channels, bitDepth));
        }

        // Skip back to where we are if the fragment starts before coveredUntilMs
        // (overlapping fragment — only take the uncovered portion).
        const sliceStartMs = Math.max(fragStart, coveredUntilMs);
        const sliceEndMs = fragEnd;

        if (sliceStartMs >= sliceEndMs) {
            // Fragment is entirely covered already.
            continue;
        }

        // Byte offsets within this fragment's PCM buffer.
        // Use floor for the start so we don't skip audio at non-integer boundaries;
        // use ceil for the end so a partial last frame is included rather than dropped.
        const byteStart = msToBytesAligned(sliceStartMs - frag.startMs, sampleRateHz, channels, bitDepth);
        const byteEnd = msToBytesAlignedCeil(sliceEndMs - frag.startMs, sampleRateHz, channels, bitDepth);
        const clampedEnd = Math.min(byteEnd, frag.pcm.length);

        if (byteStart < clampedEnd) {
            chunks.push(frag.pcm.slice(byteStart, clampedEnd));
        }

        coveredUntilMs = sliceEndMs;
    }

    // Fill any trailing silence if no fragment reaches windowEndMs.
    if (coveredUntilMs < windowEndMs) {
        chunks.push(silenceBuffer(windowEndMs - coveredUntilMs, sampleRateHz, channels, bitDepth));
    }

    return Buffer.concat(chunks);
}

module.exports = {
    assemblePcm,
    silenceBuffer,
    AssemblerFormatMismatchError,
    AssemblerInvalidFragmentError,
    isAssemblerFormatMismatchError,
    isAssemblerInvalidFragmentError,
};
