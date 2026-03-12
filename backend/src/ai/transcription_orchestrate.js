/**
 * @module transcription_orchestrate
 *
 * Orchestrates multi-chunk transcription:
 *   1. Inspect the input file.
 *   2. Plan chunks.
 *   3. Split audio (if needed).
 *   4. Transcribe each chunk with continuity prompting.
 *   5. Glue chunk transcripts with overlap removal.
 *   6. Return a rich TranscriptionResult.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const { planChunks, buildContinuityPrompt } = require("./transcription_chunk_plan");
const { glueTranscripts } = require("./transcription_glue");
const { getAudioInfo, splitIntoChunks } = require("./transcription_splitter");
const { transcribeChunk, extractStructured, TRANSCRIPTION_MODEL } = require("./transcription_openai");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */

/**
 * @typedef {object} OrchestrateCapabilities
 * @property {Environment} environment - An environment instance.
 * @property {Command} ffprobe - ffprobe command.
 * @property {Command} ffmpeg  - ffmpeg command.
 * @property {FileCreator} creator - File creator.
 * @property {FileChecker} checker - File checker.
 */

/**
 * @typedef {object} ChunkResult
 * @property {number} index
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} overlapBeforeMs
 * @property {string|null} prompt
 * @property {string} text
 * @property {Record<string, unknown>|null} usage
 * @property {unknown[]|null} logprobs
 */

/**
 * @typedef {object} TranscriptionResult
 * @property {string} text        - Final stitched transcript.
 * @property {string} provider    - Always "OpenAI".
 * @property {string} model       - Model name used.
 * @property {Record<string, number>|null} usage  - Aggregated usage (null if unavailable).
 * @property {unknown[]|null} logprobs - Logprobs from the first/only chunk.
 * @property {ChunkResult[]} chunks - Per-chunk details.
 * @property {unknown} raw        - Raw response from the first/only chunk.
 */

/**
 * Aggregates usage objects from multiple chunks.
 * @param {Array<Record<string, unknown>|null>} usages
 * @returns {Record<string, number>|null}
 */
function aggregateUsage(usages) {
    /** @type {Record<string, unknown>[]} */
    const valid = [];
    for (const u of usages) {
        if (u !== null && u !== undefined) {
            valid.push(u);
        }
    }
    if (valid.length === 0) {
        return null;
    }
    // Sum numeric fields across all usages
    /** @type {Record<string, number>} */
    const result = {};
    for (const u of valid) {
        for (const key of Object.keys(u)) {
            const v = u[key];
            if (typeof v === "number") {
                result[key] = (result[key] ?? 0) + v;
            }
        }
    }
    return result;
}

/**
 * Orchestrates multi-chunk transcription for the given file path.
 *
 * @param {(apiKey: string) => import('openai').OpenAI} makeOpenAI
 * @param {OrchestrateCapabilities} capabilities
 * @param {string} filePath - Absolute path to the audio file.
 * @returns {Promise<TranscriptionResult>}
 */
async function orchestrateTranscription(makeOpenAI, capabilities, filePath) {
    // 1. Inspect the file
    const audioInfo = await getAudioInfo(capabilities, filePath);
    const { durationMs, sizeBytes } = audioInfo;

    // 2. Plan chunks
    const specs = planChunks(sizeBytes, durationMs);

    // 3. Split audio if needed (skip when only one chunk spanning the whole file)
    const needsSplit = specs.length > 1;
    const tempDir = needsSplit
        ? fs.mkdtempSync(path.join(os.tmpdir(), "volodyslav-chunks-"))
        : null;

    /** @type {string[]} */
    let chunkPaths;
    if (needsSplit && tempDir) {
        chunkPaths = await splitIntoChunks(capabilities, filePath, specs, tempDir);
    } else {
        chunkPaths = [filePath];
    }

    // 4. Transcribe each chunk with continuity prompting
    let stitchedText = "";
    /** @type {ChunkResult[]} */
    const chunkResults = [];

    for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        if (!spec) {
            continue;
        }
        const chunkPath = chunkPaths[i] ?? filePath;
        const continuityPrompt = i === 0 ? null : buildContinuityPrompt(stitchedText);

        const chunkResult = await transcribeChunk(
            makeOpenAI,
            capabilities,
            chunkPath,
            spec.index,
            spec.startMs,
            spec.endMs,
            spec.overlapBeforeMs,
            continuityPrompt
        );
        chunkResults.push(chunkResult);

        // 5. Glue transcripts
        if (i === 0) {
            stitchedText = chunkResult.text;
        } else {
            const glued = glueTranscripts(stitchedText, chunkResult.text);
            stitchedText = glued.text;
        }
    }

    // Clean up temp directory
    if (tempDir) {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {
            // best-effort cleanup
        }
    }

    // 6. Build the rich result
    const usages = chunkResults.map((c) => c.usage);
    const firstChunk = chunkResults[0];

    return {
        text: stitchedText,
        provider: "OpenAI",
        model: TRANSCRIPTION_MODEL,
        usage: aggregateUsage(usages),
        logprobs: firstChunk?.logprobs ?? null,
        chunks: chunkResults,
        raw: firstChunk ?? null,
    };
}

/**
 * Runs structured extraction on a completed transcription result.
 *
 * @param {(apiKey: string) => import('openai').OpenAI} makeOpenAI
 * @param {OrchestrateCapabilities} capabilities
 * @param {TranscriptionResult} result - The stitched transcription result.
 * @param {Record<string, unknown>} schema - JSON Schema describing the desired structured output.
 * @param {{systemPrompt?: string}} [options]
 * @returns {Promise<{result: TranscriptionResult, structured: unknown}>}
 */
async function orchestrateStructuredExtraction(makeOpenAI, capabilities, result, schema, options) {
    const extracted = await extractStructured(makeOpenAI, capabilities, result.text, schema, options);
    return { result, structured: extracted.data };
}

module.exports = {
    orchestrateTranscription,
    orchestrateStructuredExtraction,
    aggregateUsage,
};
