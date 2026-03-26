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

const { stringToTempKey, tempKeyToString } = require("../temporary/database");
const { toISOString } = require("../datetime");
const {
    AudioSessionNotFoundError,
    AudioSessionChunkValidationError,
    AudioSessionConflictError,
    AudioSessionFinalizeError,
} = require("./errors");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../temporary/database/types').TempKey} TempKey */
/** @typedef {import('../temporary/database/types').AudioSessionMeta} AudioSessionMeta */

/**
 * @typedef {object} Capabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {Datetime} datetime
 */

// ---------------------------------------------------------------------------
// Session ID validation
// ---------------------------------------------------------------------------

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validate a session ID.
 * @param {string} sessionId
 * @returns {boolean}
 */
function isValidSessionId(sessionId) {
    return SESSION_ID_PATTERN.test(sessionId);
}

// ---------------------------------------------------------------------------
// Key builders (all keys scoped under "audio_session/")
// ---------------------------------------------------------------------------

const SESSION_NAMESPACE = "audio_session";
const CURRENT_SESSION_KEY = stringToTempKey(`${SESSION_NAMESPACE}/index/current_session_id`);

/**
 * @param {string} sessionId
 * @returns {TempKey}
 */
function metaKey(sessionId) {
    return stringToTempKey(`${SESSION_NAMESPACE}/${sessionId}/meta`);
}

/**
 * @param {string} sessionId
 * @param {number} sequence
 * @returns {TempKey}
 */
function chunkKey(sessionId, sequence) {
    const seqPadded = String(sequence).padStart(6, "0");
    return stringToTempKey(`${SESSION_NAMESPACE}/${sessionId}/chunk/${seqPadded}`);
}

/**
 * @param {string} sessionId
 * @returns {TempKey}
 */
function finalKey(sessionId) {
    return stringToTempKey(`${SESSION_NAMESPACE}/${sessionId}/final`);
}

/**
 * Prefix for all keys belonging to a session (for bulk delete).
 * @param {string} sessionId
 * @returns {string}
 */
function sessionPrefix(sessionId) {
    return `${SESSION_NAMESPACE}/${sessionId}/`;
}

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
    const entry = await temporary.getEntry(metaKey(sessionId));
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
    await temporary.putEntry(metaKey(meta.sessionId), { type: "audio_session_meta", data: meta });
}

/**
 * Read the current session id from the index.
 * Returns null if not set.
 * @param {Temporary} temporary
 * @returns {Promise<string | null>}
 */
async function readCurrentSessionId(temporary) {
    const entry = await temporary.getEntry(CURRENT_SESSION_KEY);
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
    await temporary.putEntry(CURRENT_SESSION_KEY, { type: "audio_session_index", sessionId });
}

/**
 * Delete all data for a session (all keys with the session prefix).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function deleteSessionData(temporary, sessionId) {
    await temporary.deleteKeysByPrefix(sessionPrefix(sessionId));
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

    const allSessionKeys = await temporary.listKeysByPrefix(`${SESSION_NAMESPACE}/`);
    const sessionIds = new Set();

    for (const key of allSessionKeys) {
        const keyStr = tempKeyToString(key);
        // Keys look like: audio_session/<sessionId>/...
        // Also: audio_session/index/...  (skip those)
        const afterNamespace = keyStr.slice(`${SESSION_NAMESPACE}/`.length);
        const slashIdx = afterNamespace.indexOf("/");
        if (slashIdx === -1) continue;
        const candidate = afterNamespace.slice(0, slashIdx);
        if (candidate === "index") continue;
        sessionIds.add(candidate);
    }

    for (const id of sessionIds) {
        if (id !== sessionId) {
            await deleteSessionData(temporary, id);
        }
    }
    await writeCurrentSessionId(temporary, sessionId);
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
 * @param {string} mimeType
 * @returns {Promise<AudioSessionMeta>}
 */
async function startSession(capabilities, sessionId, mimeType) {
    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }

    const { temporary } = capabilities;

    await cleanupOldSessionIfNeeded(temporary, sessionId);

    const existing = await readMeta(temporary, sessionId);
    if (existing !== null) {
        // Touch existing session: ensure index is current and update mimeType/updatedAt
        const now = toISOString(capabilities.datetime.now());
        const updatedMeta = {
            ...existing,
            mimeType,
            updatedAt: now,
        };
        await writeMeta(temporary, updatedMeta);
        await writeCurrentSessionId(temporary, sessionId);
        return updatedMeta;
    }

    const now = toISOString(capabilities.datetime.now());
    /** @type {AudioSessionMeta} */
    const meta = {
        sessionId,
        createdAt: now,
        updatedAt: now,
        status: "recording",
        mimeType,
        fragmentCount: 0,
        lastSequence: -1,
        lastEndMs: 0,
        elapsedSeconds: 0,
    };
    await writeMeta(temporary, meta);
    await writeCurrentSessionId(temporary, sessionId);

    return meta;
}

/**
 * Upload a single audio chunk for a session.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {{ chunk: Buffer, startMs: number, endMs: number, sequence: number, mimeType: string }} params
 * @returns {Promise<{ stored: { sequence: number, filename: string }, session: { fragmentCount: number, lastEndMs: number } }>}
 */
async function uploadChunk(capabilities, sessionId, params) {
    const { chunk, startMs, endMs, sequence, mimeType } = params;
    const { temporary } = capabilities;

    if (!isValidSessionId(sessionId)) {
        throw new AudioSessionChunkValidationError(
            `Invalid session ID: "${sessionId}"`
        );
    }
    if (!Number.isInteger(sequence) || sequence < 0) {
        throw new AudioSessionChunkValidationError(
            `Invalid sequence: must be a non-negative integer, got ${sequence}`
        );
    }
    if (!Number.isFinite(startMs) || startMs < 0) {
        throw new AudioSessionChunkValidationError(
            `Invalid startMs: must be a non-negative finite number, got ${startMs}`
        );
    }
    if (!Number.isFinite(endMs) || endMs < startMs) {
        throw new AudioSessionChunkValidationError(
            `Invalid endMs: must be >= startMs (${startMs}), got ${endMs}`
        );
    }

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

    const seqPadded = String(sequence).padStart(6, "0");
    const chunkTempKey = chunkKey(sessionId, sequence);
    const existingChunk = await temporary.getEntry(chunkTempKey);
    await temporary.putEntry(chunkTempKey, {
        type: "blob",
        data: chunk.toString("base64"),
    });

    const isNewChunk = existingChunk === undefined;
    const shouldUpdateLastSequence = isNewChunk && sequence > meta.lastSequence;
    const updatedMeta = {
        ...meta,
        mimeType: mimeType || meta.mimeType,
        updatedAt: toISOString(capabilities.datetime.now()),
        fragmentCount: isNewChunk ? meta.fragmentCount + 1 : meta.fragmentCount,
        lastSequence: shouldUpdateLastSequence ? sequence : meta.lastSequence,
        lastEndMs: shouldUpdateLastSequence ? endMs : meta.lastEndMs,
    };
    await writeMeta(temporary, updatedMeta);

    const filename = `${seqPadded}.webm`;
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
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {number} elapsedSeconds
 * @returns {Promise<{ status: 'stopped', finalAudioKey: string, size: number }>}
 */
async function stopSession(capabilities, sessionId, elapsedSeconds) {
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
        const finalEntry = await temporary.getEntry(finalKey(sessionId));
        const size =
            finalEntry !== undefined && finalEntry.type === "blob"
                ? Buffer.from(finalEntry.data, "base64").length
                : 0;
        return { status: "stopped", finalAudioKey: "final", size };
    }

    const chunkPrefix = `${SESSION_NAMESPACE}/${sessionId}/chunk/`;
    const chunkKeys = await temporary.listKeysByPrefix(chunkPrefix);
    const chunkKeyStrings = chunkKeys.map(tempKeyToString);
    chunkKeyStrings.sort((a, b) => a.localeCompare(b));

    /** @type {Buffer[]} */
    const buffers = [];
    for (const keyStr of chunkKeyStrings) {
        const entry = await temporary.getEntry(stringToTempKey(keyStr));
        if (entry !== undefined && entry.type === "blob") {
            buffers.push(Buffer.from(entry.data, "base64"));
        }
    }

    const finalBuffer = Buffer.concat(buffers);

    try {
        await temporary.putEntry(finalKey(sessionId), {
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

    const finalEntry = await temporary.getEntry(finalKey(sessionId));
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
        await temporary.deleteKeysByPrefix(tempKeyToString(CURRENT_SESSION_KEY));
    }
    await deleteSessionData(temporary, sessionId);
}

module.exports = {
    isValidSessionId,
    startSession,
    uploadChunk,
    getSession,
    stopSession,
    fetchFinalAudio,
    discardSession,
};
