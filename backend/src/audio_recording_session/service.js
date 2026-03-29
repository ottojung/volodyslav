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
} = require("./errors");
const {
    isValidSessionId,
    validateUploadChunkParams,
} = require("./helpers");
const {
    CURRENT_SESSION_KEY,
    indexSublevel,
    chunksSublevel,
    chunkKey,
    markSessionExists,
    unmarkSessionExists,
    listKnownSessionIds,
    deleteSessionData,
} = require("./keys");
const {
    readMeta,
    writeMeta,
    readCurrentSessionId,
    writeCurrentSessionId,
} = require("./db_helpers");

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
 * Stop a session: update status and elapsed time.
 * Elapsed duration is computed from the stored chunk timeline (lastEndMs).
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<{ status: 'stopped', elapsedSeconds: number }>}
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
        return { status: "stopped", elapsedSeconds: meta.elapsedSeconds };
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

    return { status: "stopped", elapsedSeconds };
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
    discardSession,
};
