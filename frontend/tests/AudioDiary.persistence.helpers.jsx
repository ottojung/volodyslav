import React from "react";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { submitEntry } from "../src/DescriptionEntry/api.js";
import AudioDiary from "../src/AudioDiary/AudioDiary.jsx";

/** @returns {Promise<void>} */
export const passThread = () => new Promise((resolve) => setTimeout(resolve, 0));

class MockMediaRecorder {
    /**
     * @param {MediaStream} _stream
     * @param {{ mimeType?: string }} [options]
     */
    constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || "audio/webm";
        this.state = "inactive";
        /** @type {((e: { data: Blob }) => void) | null} */
        this.ondataavailable = null;
        /** @type {(() => void) | null} */
        this.onstop = null;
        /** @type {((e: Event) => void) | null} */
        this.onerror = null;
        MockMediaRecorder._instance = this;
    }
    /** @param {number} [_timeslice] */
    start(_timeslice) { this.state = "recording"; }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    requestData() {
        if (this.ondataavailable && this.state !== "inactive") {
            passThread().then(() => {
                if (this.ondataavailable && this.state !== "inactive") {
                    this.ondataavailable({
                        data: new Blob(["partial-audio"], { type: this.mimeType }),
                    });
                }
            });
        }
    }
    stop() {
        this.state = "inactive";
        if (this.ondataavailable) {
            this.ondataavailable({
                data: new Blob(["audio-data"], { type: this.mimeType }),
            });
        }
        if (this.onstop) this.onstop();
    }
}
MockMediaRecorder.isTypeSupported = jest.fn(() => true);
MockMediaRecorder._instance = null;

function makeIndexedDBMock() {
    /** @type {Map<string, unknown>} */
    const store = new Map();
    const mockDB = {
        transaction: jest.fn().mockImplementation(() => {
            const tx = {
                oncomplete: null,
                onerror: null,
                objectStore: jest.fn().mockImplementation(() => ({
                    put: jest.fn().mockImplementation((value, key) => {
                        store.set(String(key), value);
                        passThread().then(() => {
                            if (typeof tx.oncomplete === "function") tx.oncomplete();
                        });
                    }),
                    get: jest.fn().mockImplementation((key) => {
                        const req = { result: store.get(String(key)) };
                        passThread().then(() => {
                            if (typeof req.onsuccess === "function") {
                                // @ts-expect-error mock request object does not implement full IDBRequest typing
                                req.onsuccess();
                            }
                        });
                        return req;
                    }),
                    delete: jest.fn().mockImplementation((key) => {
                        store.delete(String(key));
                        passThread().then(() => {
                            if (typeof tx.oncomplete === "function") tx.oncomplete();
                        });
                    }),
                })),
            };
            return tx;
        }),
        objectStoreNames: { contains: jest.fn().mockReturnValue(false) },
        createObjectStore: jest.fn(),
    };
    return {
        open: jest.fn().mockImplementation(() => {
            const req = {
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                result: mockDB,
            };
            passThread().then(() => {
                if (typeof req.onupgradeneeded === "function") {
                    req.onupgradeneeded({ target: req });
                }
                if (typeof req.onsuccess === "function") req.onsuccess();
            });
            return req;
        }),
        store,
    };
}

/** @type {ReturnType<typeof makeIndexedDBMock>} */
let mockIDB;
/** @type {jest.Mock} */
let mockGetUserMedia;
/** @type {typeof global.MediaRecorder | undefined} */
let originalMediaRecorder;
/** @type {typeof navigator.mediaDevices | undefined} */
let originalMediaDevices;
/** @type {typeof URL.createObjectURL} */
let originalCreateObjectURL;
/** @type {typeof URL.revokeObjectURL} */
let originalRevokeObjectURL;
/** @type {typeof HTMLCanvasElement.prototype.getContext} */
let originalCanvasGetContext;
/** @type {typeof globalThis.indexedDB | undefined} */
let originalIndexedDB;
/** @type {boolean} */
let hadMediaDevices;

export const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
    ...jest.requireActual("react-router-dom"),
    useNavigate: () => mockNavigate,
}));

export function setupAudioDiaryPersistenceHarness() {
    beforeAll(() => {
        originalMediaRecorder = global.MediaRecorder;
        originalMediaDevices = global.navigator.mediaDevices;
        hadMediaDevices = typeof originalMediaDevices !== "undefined";
        originalCreateObjectURL = global.URL.createObjectURL;
        originalRevokeObjectURL = global.URL.revokeObjectURL;
        originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
        originalIndexedDB = global.indexedDB;
        global.MediaRecorder = MockMediaRecorder;
        mockGetUserMedia = jest.fn().mockResolvedValue({
            getTracks: () => [{ stop: jest.fn() }],
            getAudioTracks: () => [{ stop: jest.fn() }],
        });
        if (!global.navigator.mediaDevices) {
            Object.defineProperty(global.navigator, "mediaDevices", {
                value: {}, writable: true, configurable: true,
            });
        }
        global.navigator.mediaDevices.getUserMedia = mockGetUserMedia;
        global.URL.createObjectURL = jest.fn().mockReturnValue("blob:mock-url");
        global.URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
        jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
            () => Promise.resolve()
        );
        HTMLCanvasElement.prototype.getContext = jest.fn(() => null);
    });

    beforeEach(() => {
        mockNavigate.mockClear();
        submitEntry.mockReset();
        submitEntry.mockResolvedValue({ success: true, entry: { id: "entry-123" } });
        mockGetUserMedia.mockClear();
        MockMediaRecorder._instance = null;
        mockIDB = makeIndexedDBMock();
        // @ts-expect-error assigning map-backed mock instead of full IDBFactory
        global.indexedDB = mockIDB;
    });

    afterEach(() => {
        cleanup();
        // @ts-expect-error assigning map-backed mock instead of full IDBFactory
        global.indexedDB = mockIDB;
    });

    afterAll(() => {
        jest.restoreAllMocks();
        global.MediaRecorder = originalMediaRecorder;
        if (hadMediaDevices && originalMediaDevices) {
            global.navigator.mediaDevices = originalMediaDevices;
        } else {
            // @ts-expect-error tests intentionally remove mediaDevices for cleanup parity
            delete global.navigator.mediaDevices;
        }
        global.URL.createObjectURL = originalCreateObjectURL;
        global.URL.revokeObjectURL = originalRevokeObjectURL;
        HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
        if (originalIndexedDB !== undefined) {
            global.indexedDB = originalIndexedDB;
        }
    });
}

/**
 * @param {string} [initialPath]
 */
export function renderAudioDiary(initialPath = "/record-diary") {
    return render(
        <ChakraProvider value={defaultSystem}>
            <MemoryRouter initialEntries={[initialPath]}>
                <Routes>
                    <Route path="/record-diary" element={<AudioDiary />} />
                    <Route path="/entry/:id" element={<div>Entry page</div>} />
                    <Route path="/" element={<div>Home page</div>} />
                </Routes>
            </MemoryRouter>
        </ChakraProvider>
    );
}

/**
 * @param {import('../src/AudioDiary/recording_storage.js').RecordingSnapshot} snapshot
 */
export function injectSnapshot(snapshot) {
    mockIDB.store.set("current", snapshot);
}

export function currentStore() {
    return mockIDB.store;
}
