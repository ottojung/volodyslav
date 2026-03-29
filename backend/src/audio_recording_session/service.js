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
} = require("./helpers");
const { buildWav } = require("../build_wav");
const {
    CURRENT_SESSION_KEY,
    indexSublevel,
    sessionSublevel,
    chunksSublevel,
    mediaChunksSublevel,
    finalKey,
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
const { uploadChunk } = require("./upload_chunk");

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
        finalizationMode: "pcm_wav",
        mediaMimeType: "",
        mediaFragmentCount: 0,
        hasRestoreBoundary: false,
        mediaCaptureId: "",
        mediaContiguousEligible: true,
    };
    await writeMeta(temporary, meta);
    await writeCurrentSessionId(temporary, sessionId);
    await markSessionExists(temporary, sessionId);

    return meta;
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

    // Determine finalization mode
    const useMediaNative =
        meta.mediaFragmentCount > 0 &&
        meta.mediaContiguousEligible === true &&
        meta.hasRestoreBoundary === false;

    let finalBuffer;
    let finalMimeType;

    if (useMediaNative) {
        // Media-native finalization: concatenate media chunks in sequence order
        const mediaChunksLevel = mediaChunksSublevel(temporary, sessionId);
        const mediaKeys = await mediaChunksLevel.listKeys();
        mediaKeys.sort((a, b) => String(a).localeCompare(String(b)));

        /** @type {Buffer[]} */
        const mediaBuffers = [];
        for (const key of mediaKeys) {
            const entry = await mediaChunksLevel.get(key);
            if (entry !== undefined && entry.type === "blob") {
                mediaBuffers.push(Buffer.from(entry.data, "base64"));
            }
        }
        finalBuffer = Buffer.concat(mediaBuffers);
        finalMimeType = meta.mediaMimeType || "audio/webm";
    } else {
        // PCM→WAV finalization (existing path)
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
        finalBuffer = buildWav(concatenatedPcm, sampleRateHz, channels, bitDepth);
        finalMimeType = "audio/wav";
    }

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
        mimeType: finalMimeType,
        finalizationMode: useMediaNative ? "media_native" : "pcm_wav",
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
