/**
 * Persistent storage for in-progress audio diary recording sessions.
 *
 * Uses IndexedDB to survive page reloads, tab switches, and other interrupts.
 * The stored snapshot contains the audio data collected so far, the elapsed
 * recording time, and any user-typed note.
 *
 * @module recording_storage
 */

/** @typedef {import('./audio_helpers.js').RecorderState} RecorderState */

const DB_NAME = "AudioDiaryRecording";
const DB_VERSION = 1;
const STORE_NAME = "snapshot";
const RECORD_KEY = "current";

/**
 * @typedef {object} RecordingSnapshot
 * @property {Exclude<RecorderState, 'idle'>} recorderState - Saved recorder state
 * @property {number} elapsedSeconds - Elapsed recording time in seconds
 * @property {string} note - User note text
 * @property {string} mimeType - Audio MIME type
 * @property {ArrayBuffer} audioBuffer - Accumulated audio data
 */

class RecordingStorageError extends Error {
    /**
     * @param {string} message
     * @param {unknown} [cause]
     */
    constructor(message, cause) {
        super(message);
        this.name = "RecordingStorageError";
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is RecordingStorageError}
 */
export function isRecordingStorageError(object) {
    return object instanceof RecordingStorageError;
}

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
    if (typeof indexedDB === "undefined") {
        return Promise.reject(
            new RecordingStorageError("IndexedDB is not available")
        );
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            reject(
                new RecordingStorageError(
                    "Failed to open recording storage database",
                    request.error
                )
            );
        };

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
            const target = event.target;
            if (!target) {
                return;
            }
            if (
                typeof IDBOpenDBRequest !== "undefined" &&
                target instanceof IDBOpenDBRequest
            ) {
                const db = target.result;
                if (db && !db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
                return;
            }

            // Fallback for environments where IDBOpenDBRequest is not defined
            /** @type {unknown} */
            const maybeDb = target.result;
            const db = /** @type {IDBDatabase | null | undefined} */ (maybeDb);
            if (
                db &&
                typeof db === "object" &&
                "objectStoreNames" in db &&
                db.objectStoreNames &&
                typeof db.objectStoreNames.contains === "function" &&
                typeof db.createObjectStore === "function" &&
                !db.objectStoreNames.contains(STORE_NAME)
            ) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

/**
 * Convert a Blob to an ArrayBuffer.
 *
 * Uses the native Blob.arrayBuffer() when available, and falls back to
 * FileReader for environments that do not implement it (e.g. jsdom in Jest).
 *
 * @param {Blob} blob
 * @returns {Promise<ArrayBuffer>}
 */
export function blobToArrayBuffer(blob) {
    if (typeof blob.arrayBuffer === "function") {
        return blob.arrayBuffer();
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (reader.result instanceof ArrayBuffer) {
                resolve(reader.result);
            } else {
                reject(new Error("FileReader: expected ArrayBuffer result"));
            }
        };
        reader.onerror = () =>
            reject(reader.error ?? new Error("FileReader error"));
        reader.readAsArrayBuffer(blob);
    });
}

/**
 * Save a recording snapshot to IndexedDB.
 * Fails silently if IndexedDB is unavailable or the write fails.
 * @param {RecordingSnapshot} snapshot
 * @returns {Promise<void>}
 */
export async function saveRecordingSnapshot(snapshot) {
    try {
        const db = await openDatabase();
        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], "readwrite");
            tx.onerror = () =>
                reject(
                    new RecordingStorageError(
                        "Failed to save recording snapshot",
                        tx.error
                    )
                );
            tx.oncomplete = () => resolve(undefined);
            tx.objectStore(STORE_NAME).put(snapshot, RECORD_KEY);
        });
    } catch {
        // Silently ignore storage failures; recording still works in-memory
    }
}

/**
 * Load the saved recording snapshot from IndexedDB.
 * Returns null if no snapshot is stored or if IndexedDB is unavailable.
 * @returns {Promise<RecordingSnapshot | null>}
 */
export async function loadRecordingSnapshot() {
    try {
        const db = await openDatabase();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], "readonly");
            const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
            req.onerror = () =>
                reject(
                    new RecordingStorageError(
                        "Failed to load recording snapshot",
                        req.error
                    )
                );
            req.onsuccess = () => resolve(req.result || null);
        });
    } catch {
        return null;
    }
}

/**
 * Clear the saved recording snapshot from IndexedDB.
 * Fails silently if IndexedDB is unavailable or the delete fails.
 * @returns {Promise<void>}
 */
export async function clearRecordingSnapshot() {
    try {
        const db = await openDatabase();
        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], "readwrite");
            tx.onerror = () =>
                reject(
                    new RecordingStorageError(
                        "Failed to clear recording snapshot",
                        tx.error
                    )
                );
            tx.oncomplete = () => resolve(undefined);
            tx.objectStore(STORE_NAME).delete(RECORD_KEY);
        });
    } catch {
        // Silently ignore storage failures
    }
}
