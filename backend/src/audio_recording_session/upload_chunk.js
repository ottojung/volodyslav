/**
 * Upload chunk service: handles PCM and media chunk ingestion for audio sessions.
 * @module audio_recording_session/upload_chunk
 */

const { toISOString } = require("../datetime");
const {
    AudioSessionNotFoundError,
    AudioSessionChunkValidationError,
    AudioSessionConflictError,
} = require("./errors");
const {
    isValidSessionId,
    validateUploadChunkParams,
    parseAudioMimeType,
} = require("./helpers");
const {
    chunksSublevel,
    mediaChunksSublevel,
    chunkKey,
    mediaChunkKey,
} = require("./keys");
const {
    readMeta,
    writeMeta,
} = require("./db_helpers");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../temporary/database/types').AudioSessionMeta} AudioSessionMeta */

/**
 * @typedef {object} UploadChunkCapabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {Datetime} datetime
 */

/**
 * Upload a single raw PCM chunk and/or a media chunk for a session.
 *
 * PCM track: required for live-diary AI processing.
 * Media track: optional; used for media-native finalization when contiguous.
 *
 * @param {UploadChunkCapabilities} capabilities
 * @param {string} sessionId
 * @param {{ pcm?: Buffer, sampleRateHz?: number, channels?: number, bitDepth?: number, startMs: number, endMs: number, sequence: number, media?: Buffer, mediaMimeType?: string, captureId?: string, hasRestoreBoundary?: boolean }} params
 * @returns {Promise<{ stored: { sequence: number, filename: string }, session: { fragmentCount: number, lastEndMs: number }, hasPcm: boolean, hasMedia: boolean, mediaContiguousEligible: boolean }>}
 */
async function uploadChunk(capabilities, sessionId, params) {
    const { pcm, sampleRateHz, channels, bitDepth, endMs, sequence, media, mediaMimeType, captureId, hasRestoreBoundary } = params;
    const { temporary } = capabilities;

    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }

    const hasPcm = pcm !== undefined;
    const hasMedia = media !== undefined && media.length > 0;

    if (!hasPcm && !hasMedia) {
        throw new AudioSessionChunkValidationError(
            "At least one of pcm or media must be provided"
        );
    }

    if (hasPcm) {
        const uploadError = validateUploadChunkParams({ pcm, sampleRateHz, channels, bitDepth, startMs: params.startMs, endMs, sequence });
        if (uploadError !== null) {
            throw new AudioSessionChunkValidationError(uploadError);
        }
    } else {
        // Validate common timing/sequence fields even without PCM
        const { startMs } = params;
        if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 || sequence > 999999) {
            throw new AudioSessionChunkValidationError(
                `Invalid sequence: must be a non-negative integer not exceeding 999999, got ${sequence}`
            );
        }
        if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) {
            throw new AudioSessionChunkValidationError(
                `Invalid startMs: must be a non-negative finite number, got ${startMs}`
            );
        }
        if (typeof endMs !== "number" || !Number.isFinite(endMs) || endMs < startMs) {
            throw new AudioSessionChunkValidationError(
                `Invalid endMs: must be >= startMs (${startMs}), got ${endMs}`
            );
        }
    }

    capabilities.logger.logDebug(
        { sessionId, sequence, hasPcm, hasMedia, pcmBytes: hasPcm ? pcm.length : 0 },
        "uploadChunk: reading session metadata"
    );

    const meta = await readMeta(temporary, sessionId);
    if (meta === null) {
        throw new AudioSessionNotFoundError(sessionId);
    }
    if (meta.status === "stopped") {
        throw new AudioSessionConflictError(
            `Cannot upload chunk to finalized session: ${sessionId}`,
            sessionId
        );
    }

    // --- PCM track ---
    let updatedMeta = meta;
    let pcmFilename = `${String(sequence).padStart(6, "0")}.pcm`;

    if (hasPcm) {
        // Validate PCM format consistency across fragments.
        // On first chunk (sampleRateHz === 0), accept any valid format.
        const formatMismatch = meta.sampleRateHz !== 0 && (
            meta.sampleRateHz !== sampleRateHz || meta.channels !== channels || meta.bitDepth !== bitDepth
        );
        if (formatMismatch) {
            throw new AudioSessionChunkValidationError(
                `PCM format mismatch: expected ${meta.sampleRateHz}Hz/${meta.channels}ch/${meta.bitDepth}bit, ` +
                `got ${sampleRateHz}Hz/${channels}ch/${bitDepth}bit`
            );
        }

        const seqPadded = String(sequence).padStart(6, "0");
        const sessionChunks = chunksSublevel(temporary, sessionId);
        const chunkTempKey = chunkKey(sequence);
        const existingChunk = await sessionChunks.get(chunkTempKey);

        const isNewChunk = existingChunk === undefined;

        await sessionChunks.put(chunkTempKey, {
            type: "blob",
            data: pcm.toString("base64"),
        });

        const shouldUpdateLastSequence = isNewChunk && sequence > meta.lastSequence;
        // Also update lastEndMs when overwriting the current latest chunk,
        // so session metadata stays accurate if the client retries with a different endMs.
        const isOverwriteOfLatestChunk = !isNewChunk && sequence === meta.lastSequence;
        updatedMeta = {
            ...updatedMeta,
            updatedAt: toISOString(capabilities.datetime.now()),
            fragmentCount: isNewChunk ? meta.fragmentCount + 1 : meta.fragmentCount,
            lastSequence: shouldUpdateLastSequence ? sequence : meta.lastSequence,
            lastEndMs: shouldUpdateLastSequence || isOverwriteOfLatestChunk ? endMs : meta.lastEndMs,
            // Store format info from first chunk (subsequent chunks must match).
            sampleRateHz: meta.sampleRateHz !== 0 ? meta.sampleRateHz : (sampleRateHz ?? 0),
            channels: meta.channels !== 0 ? meta.channels : (channels ?? 0),
            bitDepth: meta.bitDepth !== 0 ? meta.bitDepth : (bitDepth ?? 0),
        };

        capabilities.logger.logDebug(
            {
                sessionId,
                sequence,
                isNewChunk,
                fragmentCount: updatedMeta.fragmentCount,
                lastEndMs: updatedMeta.lastEndMs,
            },
            "uploadChunk: PCM fragment stored"
        );

        pcmFilename = `${seqPadded}.pcm`;
    }

    // --- Media track ---
    let mediaContiguousEligible = updatedMeta.mediaContiguousEligible;

    if (hasRestoreBoundary) {
        mediaContiguousEligible = false;
    }

    if (hasMedia) {
        // Normalize media MIME type
        const normalizedMime = mediaMimeType ? (parseAudioMimeType(mediaMimeType) || mediaMimeType) : "";

        // Check for capture ID mismatch (new MediaRecorder run)
        if (captureId && updatedMeta.mediaCaptureId && captureId !== updatedMeta.mediaCaptureId) {
            mediaContiguousEligible = false;
        }

        // Check for MIME type mismatch across chunks
        if (updatedMeta.mediaMimeType && normalizedMime && normalizedMime !== updatedMeta.mediaMimeType) {
            mediaContiguousEligible = false;
        }

        const mediaChunksLevel = mediaChunksSublevel(temporary, sessionId);
        const mediaKey = mediaChunkKey(sequence);
        const existingMediaChunk = await mediaChunksLevel.get(mediaKey);
        const isNewMediaChunk = existingMediaChunk === undefined;

        await mediaChunksLevel.put(mediaKey, {
            type: "blob",
            data: media.toString("base64"),
        });

        updatedMeta = {
            ...updatedMeta,
            updatedAt: toISOString(capabilities.datetime.now()),
            mediaFragmentCount: isNewMediaChunk ? updatedMeta.mediaFragmentCount + 1 : updatedMeta.mediaFragmentCount,
            mediaMimeType: updatedMeta.mediaMimeType || normalizedMime,
            mediaCaptureId: captureId || updatedMeta.mediaCaptureId,
            mediaContiguousEligible,
        };
    } else {
        updatedMeta = {
            ...updatedMeta,
            mediaContiguousEligible,
        };
    }

    await writeMeta(temporary, updatedMeta);

    return {
        stored: { sequence, filename: pcmFilename },
        session: {
            fragmentCount: updatedMeta.fragmentCount,
            lastEndMs: updatedMeta.lastEndMs,
        },
        hasPcm,
        hasMedia,
        mediaContiguousEligible: updatedMeta.mediaContiguousEligible,
    };
}

module.exports = { uploadChunk };
