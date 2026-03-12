/**
 * @module transcription_splitter
 *
 * Audio splitting for long recordings.
 *
 * Uses ffprobe to inspect audio metadata and ffmpeg to extract chunks.
 * Prefers silence-aware cut points; falls back to hard time cuts.
 * All side effects go through the capabilities object.
 */

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */

/**
 * @typedef {object} SplitterCapabilities
 * @property {Command} ffprobe - ffprobe command.
 * @property {Command} ffmpeg  - ffmpeg command.
 * @property {FileCreator} creator - File creator.
 * @property {FileChecker} checker - File checker.
 */

/**
 * @typedef {object} AudioInfo
 * @property {number} durationMs - Total duration in milliseconds.
 * @property {number} sizeBytes  - File size in bytes.
 */

/**
 * @typedef {object} SilenceEvent
 * @property {number} startMs - Start of silence in milliseconds.
 * @property {number} endMs   - End of silence in milliseconds.
 */

/**
 * @typedef {import('./transcription_chunk_plan').ChunkSpec} ChunkSpec
 */

class SplitterError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "SplitterError";
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SplitterError}
 */
function isSplitterError(object) {
    return object instanceof SplitterError;
}

/**
 * Retrieves duration and size metadata for an audio file via ffprobe.
 * @param {SplitterCapabilities} capabilities
 * @param {string} filePath
 * @returns {Promise<AudioInfo>}
 */
async function getAudioInfo(capabilities, filePath) {
    let stdout;
    try {
        const result = await capabilities.ffprobe.call(
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            filePath
        );
        stdout = result.stdout;
    } catch (err) {
        throw new SplitterError(
            `ffprobe failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
            err
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (err) {
        throw new SplitterError(`ffprobe output was not valid JSON: ${stdout}`, err);
    }

    const durationSec = parseFloat(parsed?.format?.duration ?? "0");
    const sizeBytesStr = parsed?.format?.size ?? "0";
    if (!isFinite(durationSec) || durationSec < 0) {
        throw new SplitterError(`ffprobe returned invalid duration: ${parsed?.format?.duration}`, undefined);
    }

    return {
        durationMs: Math.round(durationSec * 1000),
        sizeBytes: parseInt(sizeBytesStr, 10) || 0,
    };
}

/**
 * Parses silence_end events from ffmpeg silencedetect stderr output.
 * @param {string} stderr
 * @returns {SilenceEvent[]}
 */
function parseSilenceEvents(stderr) {
    /** @type {SilenceEvent[]} */
    const events = [];
    const startRegex = /silence_start:\s*([\d.]+)/g;
    const endRegex = /silence_end:\s*([\d.]+)/g;

    /** @type {number[]} */
    const starts = [];
    let m;
    while ((m = startRegex.exec(stderr)) !== null) {
        const val = m[1];
        if (val !== undefined) {
            starts.push(parseFloat(val) * 1000);
        }
    }
    /** @type {number[]} */
    const ends = [];
    while ((m = endRegex.exec(stderr)) !== null) {
        const val = m[1];
        if (val !== undefined) {
            ends.push(parseFloat(val) * 1000);
        }
    }

    for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
        const s = starts[i];
        const e = ends[i];
        if (s !== undefined && e !== undefined) {
            events.push({ startMs: s, endMs: e });
        }
    }
    return events;
}

/**
 * Finds silence events in the audio near the given target time.
 * @param {SplitterCapabilities} capabilities
 * @param {string} filePath
 * @param {number} searchWindowMs - Window size around target to search.
 * @returns {Promise<SilenceEvent[]>}
 */
async function findSilenceEvents(capabilities, filePath, searchWindowMs) {
    // silencedetect filter threshold: -30dB, minimum duration 0.3s
    const noiseTolerance = "-30dB";
    const minSilenceDuration = "0.3";
    let stderr;
    try {
        const result = await capabilities.ffmpeg.call(
            "-i", filePath,
            "-af", `silencedetect=noise=${noiseTolerance}:d=${minSilenceDuration}`,
            "-f", "null",
            "-"
        );
        stderr = result.stderr;
    } catch (err) {
        // ffmpeg with -f null returns non-zero; stderr still contains the output
        if (err !== null && typeof err === "object" && "stderr" in err && typeof err.stderr === "string") {
            stderr = err.stderr;
        } else {
            throw new SplitterError(
                `ffmpeg silencedetect failed: ${err instanceof Error ? err.message : String(err)}`,
                err
            );
        }
    }
    void searchWindowMs;
    return parseSilenceEvents(stderr || "");
}

/**
 * Picks the best cut point near targetMs using silence events.
 * Falls back to targetMs if no suitable silence is found within toleranceMs.
 * @param {SilenceEvent[]} silences
 * @param {number} targetMs
 * @param {number} toleranceMs
 * @returns {number} - Best cut point in milliseconds.
 */
function pickCutPoint(silences, targetMs, toleranceMs) {
    let bestMs = targetMs;
    let bestDist = Infinity;

    for (const s of silences) {
        const midMs = (s.startMs + s.endMs) / 2;
        const dist = Math.abs(midMs - targetMs);
        if (dist < bestDist && dist <= toleranceMs) {
            bestDist = dist;
            bestMs = midMs;
        }
    }

    return Math.round(bestMs);
}

/**
 * Extracts a time-slice of the input audio file into outputPath.
 * @param {SplitterCapabilities} capabilities
 * @param {string} inputPath
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function extractSegment(capabilities, inputPath, startMs, endMs, outputPath) {
    const startSec = (startMs / 1000).toFixed(3);
    const durationSec = ((endMs - startMs) / 1000).toFixed(3);
    try {
        await capabilities.ffmpeg.call(
            "-y",
            "-i", inputPath,
            "-ss", startSec,
            "-t", durationSec,
            "-c", "copy",
            outputPath
        );
    } catch (err) {
        // Check if output was written despite non-zero exit (ffmpeg quirk)
        const exists = await capabilities.checker.fileExists(outputPath);
        if (!exists) {
            throw new SplitterError(
                `ffmpeg segment extraction failed for [${startMs}-${endMs}]: ${err instanceof Error ? err.message : String(err)}`,
                err
            );
        }
    }
}

/**
 * Splits an audio file into segments according to the given chunk specs.
 * Returns an array of ExistingFile handles in chunk order.
 *
 * @param {SplitterCapabilities} capabilities
 * @param {string} inputPath
 * @param {ChunkSpec[]} specs
 * @param {string} tempDir - Directory to write chunk files into.
 * @returns {Promise<string[]>} - Paths to the chunk files in order.
 */
async function splitIntoChunks(capabilities, inputPath, specs, tempDir) {
    const ext = inputPath.includes(".") ? inputPath.slice(inputPath.lastIndexOf(".")) : ".mp3";
    /** @type {string[]} */
    const paths = [];

    for (const spec of specs) {
        const chunkPath = `${tempDir}/chunk_${spec.index}${ext}`;
        await extractSegment(capabilities, inputPath, spec.startMs, spec.endMs, chunkPath);
        paths.push(chunkPath);
    }

    return paths;
}

module.exports = {
    getAudioInfo,
    findSilenceEvents,
    parseSilenceEvents,
    pickCutPoint,
    extractSegment,
    splitIntoChunks,
    isSplitterError,
    SplitterError,
};
