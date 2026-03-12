/**
 * @module transcription_openai
 *
 * OpenAI audio transcription for a single audio segment.
 *
 * Uses the gpt-4o-transcribe model with JSON (verbose_json) output and
 * requests logprobs where the API supports it.
 */

const fs = require("fs");
const { OpenAI } = require("openai");
const memoize = require("@emotion/memoize").default;
const memconst = require("../memconst");

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} OpenAITranscriptionCapabilities
 * @property {Environment} environment - An environment instance.
 */

/** Model to use for transcription. */
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

/** Model to use for structured extraction. */
const STRUCTURED_MODEL = "gpt-4o";

class OpenAITranscriptionError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "OpenAITranscriptionError";
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is OpenAITranscriptionError}
 */
function isOpenAITranscriptionError(object) {
    return object instanceof OpenAITranscriptionError;
}

/**
 * @typedef {object} ChunkTranscriptionResult
 * @property {number} index          - Chunk index.
 * @property {number} startMs        - Start time in milliseconds.
 * @property {number} endMs          - End time in milliseconds.
 * @property {number} overlapBeforeMs - Overlap with previous chunk.
 * @property {string|null} prompt    - Continuity prompt used (or null for first chunk).
 * @property {string} text           - Transcribed text.
 * @property {Record<string, unknown>|null} usage     - Token usage metadata from OpenAI.
 * @property {unknown[]|null} logprobs - Log-probability data if available.
 */

/**
 * Transcribes a single audio file chunk using the OpenAI API.
 *
 * @param {(apiKey: string) => OpenAI} makeOpenAI - Memoised factory for OpenAI client.
 * @param {OpenAITranscriptionCapabilities} capabilities
 * @param {string} filePath          - Path to the audio segment.
 * @param {number} chunkIndex        - Chunk index.
 * @param {number} startMs           - Chunk start in ms.
 * @param {number} endMs             - Chunk end in ms.
 * @param {number} overlapBeforeMs   - Overlap amount in ms.
 * @param {string|null} continuityPrompt - Previous transcript tail (null for first chunk).
 * @returns {Promise<ChunkTranscriptionResult>}
 */
async function transcribeChunk(
    makeOpenAI,
    capabilities,
    filePath,
    chunkIndex,
    startMs,
    endMs,
    overlapBeforeMs,
    continuityPrompt
) {
    const apiKey = capabilities.environment.openaiAPIKey();
    const openai = makeOpenAI(apiKey);

    /** @type {import('openai').OpenAI.Audio.TranscriptionCreateParamsNonStreaming} */
    const params = {
        model: TRANSCRIPTION_MODEL,
        file: fs.createReadStream(filePath),
        // "json" response format supports logprobs; "verbose_json" does not
        response_format: "json",
        include: ["logprobs"],
    };

    if (continuityPrompt !== null && continuityPrompt.length > 0) {
        params.prompt = continuityPrompt;
    }

    /** @type {import('openai').OpenAI.Audio.Transcription} */
    let raw;
    try {
        raw = await openai.audio.transcriptions.create(params);
    } catch (err) {
        throw new OpenAITranscriptionError(
            `Transcription failed for chunk ${chunkIndex}: ${err instanceof Error ? err.message : String(err)}`,
            err
        );
    }

    const text = raw.text;
    const logprobs = raw.logprobs ?? null;

    return {
        index: chunkIndex,
        startMs,
        endMs,
        overlapBeforeMs,
        prompt: continuityPrompt,
        text,
        usage: null,
        logprobs,
    };
}

/**
 * @typedef {object} StructuredExtractionResult
 * @property {unknown} data - The extracted structured object.
 * @property {object|null} usage - Token usage metadata.
 */

/**
 * Extracts a structured JSON object from a transcript using OpenAI structured outputs.
 *
 * @param {(apiKey: string) => OpenAI} makeOpenAI
 * @param {OpenAITranscriptionCapabilities} capabilities
 * @param {string} transcriptText - The full stitched transcript.
 * @param {Record<string, unknown>} schema - JSON Schema describing the target object.
 * @param {{systemPrompt?: string}} [options]
 * @returns {Promise<StructuredExtractionResult>}
 */
async function extractStructured(makeOpenAI, capabilities, transcriptText, schema, options) {
    const apiKey = capabilities.environment.openaiAPIKey();
    const openai = makeOpenAI(apiKey);

    const systemPrompt =
        options?.systemPrompt ??
        "Extract the requested information from the transcript. Respond only with a JSON object matching the given schema.";

    let response;
    try {
        /** @type {import('openai').OpenAI.ResponseFormatJSONSchema} */
        const responseFormat = {
            type: "json_schema",
            json_schema: { name: "extraction", strict: true, schema },
        };
        response = await openai.chat.completions.create({
            model: STRUCTURED_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: transcriptText },
            ],
            response_format: responseFormat,
        });
    } catch (err) {
        throw new OpenAITranscriptionError(
            `Structured extraction failed: ${err instanceof Error ? err.message : String(err)}`,
            err
        );
    }

    const content = response.choices[0]?.message?.content ?? "{}";
    let data;
    try {
        data = JSON.parse(content);
    } catch (err) {
        throw new OpenAITranscriptionError(
            `Structured extraction returned invalid JSON: ${content}`,
            err
        );
    }

    return { data, usage: response.usage ?? null };
}

/**
 * Creates a memoised OpenAI client factory scoped to a capabilities getter.
 * @param {() => OpenAITranscriptionCapabilities} getCapabilities
 * @returns {{ makeOpenAI: (apiKey: string) => OpenAI, getCapabilities: () => OpenAITranscriptionCapabilities }}
 */
function makeOpenAIFactory(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const makeOpenAI = memoize((apiKey) => new OpenAI({ apiKey }));
    return { makeOpenAI, getCapabilities: getCapabilitiesMemo };
}

module.exports = {
    transcribeChunk,
    extractStructured,
    makeOpenAIFactory,
    isOpenAITranscriptionError,
    OpenAITranscriptionError,
    TRANSCRIPTION_MODEL,
    STRUCTURED_MODEL,
};
