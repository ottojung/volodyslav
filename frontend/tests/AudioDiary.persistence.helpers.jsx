import React from "react";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
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

/**
 * The session data that fetch will return for getSession calls.
 * @type {import('../src/AudioDiary/session_api.js').SessionState | null}
 */
let mockSessionData;

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
/** @type {typeof global.fetch | undefined} */
let originalFetch;
/** @type {boolean} */
let hadMediaDevices;

export const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
    ...jest.requireActual("react-router-dom"),
    useNavigate: () => mockNavigate,
}));

/**
 * Build a fetch mock that handles session API calls.
 * @returns {jest.Mock}
 */
function makeFetchMock() {
    return jest.fn().mockImplementation((url, options) => {
        const urlStr = String(url);

        // DELETE /audio-recording-session/:id
        if (options && options.method === "DELETE") {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // POST /entries/diary-audio
        if (options && options.method === "POST" && urlStr.includes("/entries/diary-audio")) {
            return Promise.resolve({
                ok: true,
                status: 201,
                json: () => Promise.resolve({ success: true, entry: { id: "entry-123" } }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // POST /audio-recording-session/start
        if (options && options.method === "POST" && urlStr.includes("/start")) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    success: true,
                    session: {
                        sessionId: "mock-session",
                        status: "recording",
                        createdAt: "2026-01-01T00:00:00.000Z",
                        fragmentCount: 0,
                    },
                }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // POST /audio-recording-session/:id/push-audio
        if (options && options.method === "POST" && urlStr.includes("/push-audio")) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    success: true,
                    stored: { sequence: 0, filename: "chunk-0.webm" },
                    session: { fragmentCount: 1, lastEndMs: 1000 },
                    status: "ok",
                }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // POST /audio-recording-session/:id/stop
        if (options && options.method === "POST" && urlStr.includes("/stop")) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    success: true,
                    session: { status: "stopped", size: 100 },
                }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // GET /audio-recording-session/:id/final-audio
        if (urlStr.includes("/final-audio")) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
                blob: () => Promise.resolve(new Blob(["backend-audio"], { type: "audio/webm" })),
            });
        }

        // GET /audio-recording-session/:id/live-questions
        if (!options && urlStr.includes("/live-questions")) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true, questions: [] }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // GET /audio-recording-session/:id/restore
        if (!options && urlStr.includes("/restore")) {
            if (mockSessionData) {
                const session = mockSessionData;
                const hasFinalAudio = session.status === "stopped";
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        success: true,
                        restore: {
                            status: session.status,
                            mimeType: session.mimeType || "audio/webm",
                            elapsedSeconds: session.elapsedSeconds || 0,
                            lastSequence: session.lastSequence || 0,
                            hasFinalAudio,
                        },
                    }),
                    blob: () => Promise.resolve(new Blob()),
                });
            }
            return Promise.resolve({
                ok: false,
                status: 404,
                json: () => Promise.resolve({ success: false, error: "Not found" }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // GET /audio-recording-session/:id  (session state lookup)
        if (mockSessionData) {
            const session = mockSessionData;
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true, session }),
                blob: () => Promise.resolve(new Blob()),
            });
        }

        // No session found (404)
        return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ success: false, error: "Not found" }),
            blob: () => Promise.resolve(new Blob()),
        });
    });
}

export function setupAudioDiaryPersistenceHarness() {
    beforeAll(() => {
        originalMediaRecorder = global.MediaRecorder;
        originalMediaDevices = global.navigator.mediaDevices;
        hadMediaDevices = typeof originalMediaDevices !== "undefined";
        originalCreateObjectURL = global.URL.createObjectURL;
        originalRevokeObjectURL = global.URL.revokeObjectURL;
        originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
        originalFetch = global.fetch;

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
        mockGetUserMedia.mockClear();
        MockMediaRecorder._instance = null;

        // Reset session data
        mockSessionData = null;

        // Clear real localStorage
        window.localStorage.clear();

        // Set fresh fetch mock
        global.fetch = makeFetchMock();
    });

    afterEach(() => {
        cleanup();
        window.localStorage.clear();
        if (originalFetch !== undefined) {
            global.fetch = originalFetch;
        } else {
            // @ts-expect-error tests intentionally remove fetch for cleanup parity
            delete global.fetch;
        }
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
        if (originalFetch !== undefined) {
            global.fetch = originalFetch;
        } else {
            // @ts-expect-error tests intentionally remove fetch for cleanup parity
            delete global.fetch;
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
 * Inject a session into the test environment.
 * Sets a sessionId in localStorage and configures the fetch mock
 * to return the given session state.
 *
 * @param {{ recorderState: string, elapsedSeconds: number, note: string, mimeType: string, audioBuffer?: ArrayBuffer }} snapshot
 */
export function injectSnapshot(snapshot) {
    const sessionId = "restored-session-id";
    window.localStorage.setItem("audioDiarySessionId", sessionId);

    const status = snapshot.recorderState === "stopped" ? "stopped" : "recording";
    mockSessionData = {
        sessionId,
        status,
        mimeType: snapshot.mimeType || "audio/webm",
        elapsedSeconds: snapshot.elapsedSeconds || 0,
        fragmentCount: 1,
        lastSequence: 0,
    };
}

/**
 * Returns the current localStorage keys/values as a Map-like interface.
 * Tests use this to check session ID presence.
 * @returns {{ has: (key: string) => boolean, get: (key: string) => string | null, set: (key: string, value: string) => void }}
 */
export function currentStore() {
    return {
        has: (key) => window.localStorage.getItem(key) !== null,
        get: (key) => window.localStorage.getItem(key),
        set: (key, value) => window.localStorage.setItem(key, value),
    };
}
