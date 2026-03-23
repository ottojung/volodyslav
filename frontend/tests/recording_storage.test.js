/**
 * Unit tests for recording_storage.js
 */

import {
    saveRecordingSnapshot,
    loadRecordingSnapshot,
    clearRecordingSnapshot,
    blobToArrayBuffer,
    isRecordingStorageError,
} from "../src/AudioDiary/recording_storage.js";

// ─── IndexedDB mock ───────────────────────────────────────────────────────────

const passThread = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeIndexedDBMock() {
    /** @type {Map<string, unknown>} */
    const store = new Map();

    const mockDB = {
        transaction: jest.fn().mockImplementation((_names, _mode) => {
            const tx = {
                /** @type {(() => void) | null} */
                oncomplete: null,
                /** @type {(() => void) | null} */
                onerror: null,
                objectStore: jest.fn().mockImplementation(() => ({
                    put: jest.fn().mockImplementation((value, key) => {
                        store.set(String(key), value);
                        passThread().then(() => {
                            if (typeof tx.oncomplete === "function") {
                                tx.oncomplete();
                            }
                        });
                    }),
                    get: jest.fn().mockImplementation((key) => {
                        const req = { result: store.get(String(key)) };
                        passThread().then(() => {
                            if (typeof req.onsuccess === "function") {
                                // @ts-expect-error - dynamic mock
                                req.onsuccess();
                            }
                        });
                        return req;
                    }),
                    delete: jest.fn().mockImplementation((key) => {
                        store.delete(String(key));
                        passThread().then(() => {
                            if (typeof tx.oncomplete === "function") {
                                tx.oncomplete();
                            }
                        });
                    }),
                })),
            };
            return tx;
        }),
        objectStoreNames: { contains: jest.fn().mockReturnValue(false) },
        createObjectStore: jest.fn(),
    };

    const mockIDB = {
        open: jest.fn().mockImplementation(() => {
            const req = {
                /** @type {((e: { target: unknown }) => void) | null} */
                onupgradeneeded: null,
                /** @type {(() => void) | null} */
                onsuccess: null,
                /** @type {(() => void) | null} */
                onerror: null,
                result: mockDB,
            };
            passThread().then(() => {
                if (typeof req.onupgradeneeded === "function") {
                    req.onupgradeneeded({ target: req });
                }
                if (typeof req.onsuccess === "function") {
                    req.onsuccess();
                }
            });
            return req;
        }),
        store,
    };

    return mockIDB;
}

/** @type {ReturnType<typeof makeIndexedDBMock>} */
let mockIDB;

/** @type {typeof globalThis.indexedDB | undefined} */
let originalIndexedDB;

beforeEach(() => {
    originalIndexedDB = global.indexedDB;
    mockIDB = makeIndexedDBMock();
    // @ts-expect-error – partial mock
    global.indexedDB = mockIDB;
});

afterEach(() => {
    if (originalIndexedDB !== undefined) {
        global.indexedDB = originalIndexedDB;
    } else {
        // @ts-expect-error - delete global property
        delete global.indexedDB;
    }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recording_storage: blobToArrayBuffer", () => {
    it("converts a Blob to an ArrayBuffer", async () => {
        const content = "hello audio";
        const blob = new Blob([content], { type: "audio/webm" });
        const buf = await blobToArrayBuffer(blob);
        expect(buf).toBeInstanceOf(ArrayBuffer);
        expect(buf.byteLength).toBe(content.length);
    });

    it("returns an ArrayBuffer for empty Blob", async () => {
        const blob = new Blob([], { type: "audio/webm" });
        const buf = await blobToArrayBuffer(blob);
        expect(buf).toBeInstanceOf(ArrayBuffer);
        expect(buf.byteLength).toBe(0);
    });
});

describe("recording_storage: loadRecordingSnapshot error handling", () => {
    it("returns null when IndexedDB open fails", async () => {
        // Force an error by making open() fail
        mockIDB.open.mockImplementationOnce(() => {
            const req = {
                onerror: null,
                onsuccess: null,
                onupgradeneeded: null,
                error: new Error("mock db error"),
            };
            passThread().then(() => {
                if (typeof req.onerror === "function") {
                    // @ts-expect-error - dynamic mock
                    req.onerror();
                }
            });
            return req;
        });

        // loadRecordingSnapshot swallows errors and returns null (graceful degradation)
        const result = await loadRecordingSnapshot();
        expect(result).toBeNull();
    });

});

describe("recording_storage: isRecordingStorageError", () => {
    it("returns false for plain Error", () => {
        expect(isRecordingStorageError(new Error("test"))).toBe(false);
    });

    it("returns false for null", () => {
        expect(isRecordingStorageError(null)).toBe(false);
    });
});

describe("recording_storage: save / load / clear round-trip", () => {
    it("saves a snapshot and loads it back", async () => {
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer);
        view[0] = 42;

        /** @type {import('../src/AudioDiary/recording_storage.js').RecordingSnapshot} */
        const snapshot = {
            recorderState: "paused",
            elapsedSeconds: 90,
            note: "test note",
            mimeType: "audio/webm",
            audioBuffer: buffer,
        };

        await saveRecordingSnapshot(snapshot);
        const loaded = await loadRecordingSnapshot();

        expect(loaded).not.toBeNull();
        expect(loaded?.recorderState).toBe("paused");
        expect(loaded?.elapsedSeconds).toBe(90);
        expect(loaded?.note).toBe("test note");
        expect(loaded?.mimeType).toBe("audio/webm");
    });

    it("returns null when no snapshot is stored", async () => {
        const result = await loadRecordingSnapshot();
        expect(result).toBeNull();
    });

    it("clears the snapshot so subsequent loads return null", async () => {
        const buffer = new ArrayBuffer(4);
        await saveRecordingSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 45,
            note: "",
            mimeType: "audio/ogg",
            audioBuffer: buffer,
        });

        await clearRecordingSnapshot();
        const result = await loadRecordingSnapshot();
        expect(result).toBeNull();
    });

    it("overwrites an existing snapshot with a newer save", async () => {
        const buf1 = new ArrayBuffer(4);
        const buf2 = new ArrayBuffer(8);

        await saveRecordingSnapshot({
            recorderState: "recording",
            elapsedSeconds: 10,
            note: "first",
            mimeType: "audio/webm",
            audioBuffer: buf1,
        });

        await saveRecordingSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 60,
            note: "second",
            mimeType: "audio/webm",
            audioBuffer: buf2,
        });

        const loaded = await loadRecordingSnapshot();
        expect(loaded?.elapsedSeconds).toBe(60);
        expect(loaded?.note).toBe("second");
    });
});

describe("recording_storage: graceful degradation without IndexedDB", () => {
    it("saveRecordingSnapshot resolves without error when IndexedDB is absent", async () => {
        // @ts-expect-error – testing undefined scenario
        global.indexedDB = undefined;
        const buf = new ArrayBuffer(4);
        await expect(
            saveRecordingSnapshot({
                recorderState: "paused",
                elapsedSeconds: 5,
                note: "",
                mimeType: "audio/webm",
                audioBuffer: buf,
            })
        ).resolves.toBeUndefined();
    });

    it("loadRecordingSnapshot returns null when IndexedDB is absent", async () => {
        // @ts-expect-error – testing undefined scenario
        global.indexedDB = undefined;
        const result = await loadRecordingSnapshot();
        expect(result).toBeNull();
    });

    it("clearRecordingSnapshot resolves without error when IndexedDB is absent", async () => {
        // @ts-expect-error – testing undefined scenario
        global.indexedDB = undefined;
        await expect(clearRecordingSnapshot()).resolves.toBeUndefined();
    });
});
