/**
 * Audio recording session service.
 *
 * Manages audio recording sessions in the temporary LevelDB store.
 * Key layout:
 *   audio_session/<sessionId>/meta         → session metadata (JSON)
 *   audio_session/<sessionId>/chunk/<seq>  → binary audio chunk (base64)
 *   audio_session/<sessionId>/final        → final combined audio (base64)
 *   audio_session/index/current_session_id → current session id
 *
 * @module audio_recording_session/service
 */

const { toISOString } = require("../datetime");
const {
    AudioSessionNotFoundError,
    AudioSessionChunkValidationError,
    AudioSessionConflictError,
    AudioSessionFinalizeError,
} = require("./errors");
const {
    isValidSessionId,
    validateUploadChunkParams,
} = require("./helpers");
const { buildWav } = require("../build_wav");
const {
    CURRENT_SESSION_KEY,
    indexSublevel,
    sessionSublevel,
    chunksSublevel,
    metaKey,
    chunkKey,
    finalKey,
    markSessionExists,
    unmarkSessionExists,
    listKnownSessionIds,
    deleteSessionData,
} = require("./keys");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../temporary/database/types').AudioSessionMeta} AudioSessionMeta */

/**
 * @typedef {object} Capabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {Datetime} datetime
 */

// ---------------------------------------------------------------------------
// Low-level DB helpers
// ---------------------------------------------------------------------------

/**
 * Read session metadata from the database.
 * Returns null if not found.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<AudioSessionMeta | null>}
 */
async function readMeta(temporary, sessionId) {
    const entry = await sessionSublevel(temporary, sessionId).get(metaKey());
    if (entry === undefined) {
        return null;
    }
    if (entry.type !== "audio_session_meta") {
        return null;
    }
    return entry.data;
}

/**
 * Write session metadata to the database.
 * @param {Temporary} temporary
 * @param {AudioSessionMeta} meta
 * @returns {Promise<void>}
 */
async function writeMeta(temporary, meta) {
    await sessionSublevel(temporary, meta.sessionId).put(metaKey(), { type: "audio_session_meta", data: meta });
}

/**
 * Read the current session id from the index.
 * Returns null if not set.
 * @param {Temporary} temporary
 * @returns {Promise<string | null>}
 */
async function readCurrentSessionId(temporary) {
    const entry = await indexSublevel(temporary).get(CURRENT_SESSION_KEY);
    if (entry === undefined) {
        return null;
    }
    if (entry.type !== "audio_session_index") {
        return null;
    }
    return entry.sessionId;
}

/**
 * Write the current session id to the index.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function writeCurrentSessionId(temporary, sessionId) {
    await indexSublevel(temporary).put(CURRENT_SESSION_KEY, { type: "audio_session_index", sessionId });
}

// ---------------------------------------------------------------------------
// Cleanup: delete old session when a new one starts
// ---------------------------------------------------------------------------

/**
 * Delete all audio session data that does not belong to the given sessionId.
 * This handles orphaned sessions that are not tracked in the index.
 * Short-circuits (no key scan) when the session is already current.
 * @param {Temporary} temporary
 * @param {string} sessionId - the new session to keep
 * @returns {Promise<void>}
 */
async function cleanupOldSessionIfNeeded(temporary, sessionId) {
    const currentId = await readCurrentSessionId(temporary);
    if (currentId === sessionId) {
        return; // Already current; nothing to clean up or index to update
    }

    const sessionIds = await listKnownSessionIds(temporary);
    for (const id of sessionIds) {
        if (id !== sessionId) {
            await deleteSessionData(temporary, id);
            await unmarkSessionExists(temporary, id);
        }
    }
    await writeCurrentSessionId(temporary, sessionId);
    await markSessionExists(temporary, sessionId);
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

/**
 * Initialize or touch a session. Triggers cleanup of the previous session
 * if this is a new session ID.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<AudioSessionMeta>}
 */
async function startSession(capabilities, sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }

    const { temporary } = capabilities;

    await cleanupOldSessionIfNeeded(temporary, sessionId);

    const existing = await readMeta(temporary, sessionId);
    if (existing !== null) {
        // Touch existing session: ensure index is current and update updatedAt
        const now = toISOString(capabilities.datetime.now());
        const updatedMeta = {
            ...existing,
            updatedAt: now,
        };
        await writeMeta(temporary, updatedMeta);
        await writeCurrentSessionId(temporary, sessionId);
        await markSessionExists(temporary, sessionId);
        return updatedMeta;
    }

    const now = toISOString(capabilities.datetime.now());
    /** @type {AudioSessionMeta} */
    const meta = {
        sessionId,
        createdAt: now,
        updatedAt: now,
        status: "recording",
        mimeType: "audio/wav",
        fragmentCount: 0,
        lastSequence: -1,
        lastEndMs: 0,
        elapsedSeconds: 0,
        sampleRateHz: 0,
        channels: 0,
        bitDepth: 0,
    };
    await writeMeta(temporary, meta);
    await writeCurrentSessionId(temporary, sessionId);
    await markSessionExists(temporary, sessionId);

    return meta;
}

/**
 * Upload a single raw PCM chunk for a session.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {{ pcm: Buffer, sampleRateHz: number, channels: number, bitDepth: number, startMs: number, endMs: number, sequence: number }} params
 * @returns {Promise<{ stored: { sequence: number, filename: string }, session: { fragmentCount: number, lastEndMs: number } }>}
 */
async function uploadChunk(capabilities, sessionId, params) {
    const { pcm, sampleRateHz, channels, bitDepth, endMs, sequence } = params;
    const { temporary } = capabilities;

    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }
    const uploadError = validateUploadChunkParams(params);
    if (uploadError !== null) {
        throw new AudioSessionChunkValidationError(uploadError);
    }

    capabilities.logger.logDebug(
        { sessionId, sequence, sampleRateHz, channels, bitDepth, pcmBytes: pcm.length },
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
    const updatedMeta = {
        ...meta,
        updatedAt: toISOString(capabilities.datetime.now()),
        fragmentCount: isNewChunk ? meta.fragmentCount + 1 : meta.fragmentCount,
        lastSequence: shouldUpdateLastSequence ? sequence : meta.lastSequence,
        lastEndMs: shouldUpdateLastSequence || isOverwriteOfLatestChunk ? endMs : meta.lastEndMs,
        // Store format info from first chunk (subsequent chunks must match).
        sampleRateHz: meta.sampleRateHz !== 0 ? meta.sampleRateHz : sampleRateHz,
        channels: meta.channels !== 0 ? meta.channels : channels,
        bitDepth: meta.bitDepth !== 0 ? meta.bitDepth : bitDepth,
    };
    await writeMeta(temporary, updatedMeta);

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

    const filename = `${seqPadded}.pcm`;
    return {
        stored: { sequence, filename },
        session: {
            fragmentCount: updatedMeta.fragmentCount,
            lastEndMs: updatedMeta.lastEndMs,
        },
    };
}

/**
 * Get current session state.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<AudioSessionMeta>}
 */
async function getSession(capabilities, sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }

    const meta = await readMeta(capabilities.temporary, sessionId);
    if (meta === null) {
        throw new AudioSessionNotFoundError(sessionId);
    }
    return meta;
}

/**
 * Stop and finalize a session: concatenate all chunks into a final audio file.
 * Elapsed duration is computed from the stored chunk timeline (lastEndMs).
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<{ status: 'stopped', finalAudioKey: string, size: number }>}
 */
async function stopSession(capabilities, sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }

    const { temporary } = capabilities;
    const meta = await readMeta(temporary, sessionId);
    if (meta === null) {
        throw new AudioSessionNotFoundError(sessionId);
    }

    if (meta.status === "stopped") {
        const finalEntry = await sessionSublevel(temporary, sessionId).get(finalKey());
        const size =
            finalEntry !== undefined && finalEntry.type === "blob"
                ? Buffer.from(finalEntry.data, "base64").length
                : 0;
        return { status: "stopped", finalAudioKey: "final", size };
    }

    const sessionChunks = chunksSublevel(temporary, sessionId);
    const chunkKeys = await sessionChunks.listKeys();
    chunkKeys.sort((a, b) => String(a).localeCompare(String(b)));

    /** @type {Buffer[]} */
    const pcmBuffers = [];
    for (const key of chunkKeys) {
        const entry = await sessionChunks.get(key);
        if (entry !== undefined && entry.type === "blob") {
            pcmBuffers.push(Buffer.from(entry.data, "base64"));
        }
    }

    // Concatenate all raw PCM fragments in sequence order and wrap in a single WAV file.
    // PCM sample-level concatenation is always safe: no container format concerns.
    const concatenatedPcm = Buffer.concat(pcmBuffers);

    // Use PCM format stored in session metadata.  If no chunks were uploaded yet
    // (fragmentCount === 0), fall back to a silent 16kHz mono 16-bit WAV.
    const sampleRateHz = meta.sampleRateHz || 16000;
    const channels = meta.channels || 1;
    const bitDepth = meta.bitDepth || 16;
    const finalBuffer = buildWav(concatenatedPcm, sampleRateHz, channels, bitDepth);

    try {
        await sessionSublevel(temporary, sessionId).put(finalKey(), {
            type: "blob",
            data: finalBuffer.toString("base64"),
        });
    } catch (error) {
        throw new AudioSessionFinalizeError(
            `Failed to store final audio for session ${sessionId}: ${error}`,
            sessionId,
            error
        );
    }

    // Derive elapsed seconds from chunk timeline (canonical backend timing).
    const elapsedSeconds = Math.ceil(meta.lastEndMs / 1000);

    /** @type {AudioSessionMeta} */
    const updatedMeta = {
        ...meta,
        status: "stopped",
        elapsedSeconds,
        updatedAt: toISOString(capabilities.datetime.now()),
    };
    await writeMeta(temporary, updatedMeta);

    return { status: "stopped", finalAudioKey: "final", size: finalBuffer.length };
}

/**
 * Fetch the final combined audio for a stopped session.
 * Returns the audio buffer and mime type.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function fetchFinalAudio(capabilities, sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }

    const { temporary } = capabilities;
    const meta = await readMeta(temporary, sessionId);
    if (meta === null) {
        throw new AudioSessionNotFoundError(sessionId);
    }
    if (meta.status !== "stopped") {
        throw new AudioSessionConflictError(
            `Session ${sessionId} has not been finalized yet`,
            sessionId
        );
    }

    const finalEntry = await sessionSublevel(temporary, sessionId).get(finalKey());
    if (finalEntry === undefined || finalEntry.type !== "blob") {
        throw new AudioSessionFinalizeError(
            `Final audio not found for session ${sessionId}`,
            sessionId
        );
    }

    return {
        buffer: Buffer.from(finalEntry.data, "base64"),
        mimeType: meta.mimeType,
    };
}

/**
 * Delete all data for a session.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function discardSession(capabilities, sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }
    const { temporary } = capabilities;
    // Clear the index if it pointed to this session, so the next startSession
    // does not see a stale current-session reference.
    const currentId = await readCurrentSessionId(temporary);
    if (currentId === sessionId) {
        await indexSublevel(temporary).del(CURRENT_SESSION_KEY);
    }
    await deleteSessionData(temporary, sessionId);
    await unmarkSessionExists(temporary, sessionId);
}

module.exports = {
    startSession,
    uploadChunk,
    getSession,
    stopSession,
    fetchFinalAudio,
    discardSession,
};
