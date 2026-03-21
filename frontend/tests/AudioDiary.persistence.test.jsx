/**
 * Integration tests for AudioDiary recording session persistence.
 *
 * Tests that the page saves state to IndexedDB and restores it correctly
 * when the component remounts (simulating a page reload or navigation back).
 */

import React from "react";
import {
    render,
    screen,
    fireEvent,
    waitFor,
    act,
    cleanup,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChakraProvider } from "@chakra-ui/react";

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock("../src/DescriptionEntry/api.js", () => ({
    submitEntry: jest.fn(),
}));

jest.mock("../src/DescriptionEntry/logger.js", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
    ...jest.requireActual("react-router-dom"),
    useNavigate: () => mockNavigate,
}));

// ─── Import (after mocks) ────────────────────────────────────────────────────

import AudioDiary from "../src/AudioDiary/AudioDiary.jsx";
import { submitEntry } from "../src/DescriptionEntry/api.js";

// ─── MediaRecorder mock ──────────────────────────────────────────────────────

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
    start(_timeslice) {
        this.state = "recording";
    }

    pause() {
        this.state = "paused";
    }

    resume() {
        this.state = "recording";
    }

    requestData() {
        // Emit a partial chunk for persistence
        if (this.ondataavailable && this.state !== "inactive") {
            const chunk = new Blob(["partial-audio"], { type: this.mimeType });
            this.ondataavailable({ data: chunk });
        }
    }

    stop() {
        this.state = "inactive";
        if (this.ondataavailable) {
            const chunk = new Blob(["audio-data"], { type: this.mimeType });
            this.ondataavailable({ data: chunk });
        }
        if (this.onstop) {
            this.onstop();
        }
    }
}

MockMediaRecorder.isTypeSupported = jest.fn(() => true);
/** @type {MockMediaRecorder | null} */
MockMediaRecorder._instance = null;

// ─── IndexedDB mock ──────────────────────────────────────────────────────────

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

// ─── Browser API mocks ────────────────────────────────────────────────────────

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
/** @type {boolean} */
let hadMediaDevices;
/** @type {jest.Mock} */
let mockGetUserMedia;
/** @type {ReturnType<typeof makeIndexedDBMock>} */
let mockIDB;
/** @type {typeof globalThis.indexedDB | undefined} */
let originalIndexedDB;

beforeAll(() => {
    originalMediaRecorder = global.MediaRecorder;
    originalMediaDevices = global.navigator.mediaDevices;
    hadMediaDevices = typeof originalMediaDevices !== "undefined";
    originalCreateObjectURL = global.URL.createObjectURL;
    originalRevokeObjectURL = global.URL.revokeObjectURL;
    originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;

    global.MediaRecorder = MockMediaRecorder;

    mockGetUserMedia = jest.fn().mockResolvedValue({
        getTracks: () => [{ stop: jest.fn() }],
        getAudioTracks: () => [{ stop: jest.fn() }],
    });
    if (!global.navigator.mediaDevices) {
        Object.defineProperty(global.navigator, "mediaDevices", {
            value: {},
            writable: true,
            configurable: true,
        });
    }
    global.navigator.mediaDevices.getUserMedia = mockGetUserMedia;

    global.URL.createObjectURL = jest.fn().mockReturnValue("blob:mock-url");
    global.URL.revokeObjectURL = jest.fn();

    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
        Promise.resolve()
    );

    HTMLCanvasElement.prototype.getContext = jest.fn(() => null);

    originalIndexedDB = global.indexedDB;
});

afterAll(() => {
    jest.restoreAllMocks();
    global.MediaRecorder = originalMediaRecorder;
    if (hadMediaDevices && originalMediaDevices) {
        global.navigator.mediaDevices = originalMediaDevices;
    } else {
        // @ts-expect-error - delete global
        delete global.navigator.mediaDevices;
    }
    global.URL.createObjectURL = originalCreateObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
    if (originalIndexedDB !== undefined) {
        global.indexedDB = originalIndexedDB;
    }
});

beforeEach(() => {
    mockNavigate.mockClear();
    // @ts-expect-error - mock
    submitEntry.mockReset();
    // @ts-expect-error - mock
    submitEntry.mockResolvedValue({ success: true, entry: { id: "entry-123" } });
    mockGetUserMedia.mockClear();
    MockMediaRecorder._instance = null;

    mockIDB = makeIndexedDBMock();
    // @ts-expect-error - partial mock
    global.indexedDB = mockIDB;
});

afterEach(() => {
    cleanup();
    // @ts-expect-error - partial mock
    global.indexedDB = mockIDB;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {string} [initialPath]
 */
function renderAudioDiary(initialPath = "/record-diary") {
    return render(
        <ChakraProvider>
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
 * Directly injects a snapshot into the mock IndexedDB store
 * so the next render will restore it.
 * @param {import('../src/AudioDiary/recording_storage.js').RecordingSnapshot} snapshot
 */
function injectSnapshot(snapshot) {
    mockIDB.store.set("current", snapshot);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AudioDiary persistence: no saved state", () => {
    it("does not show the session-restored banner when there is no saved state", async () => {
        renderAudioDiary();
        // Give restore effect time to run
        await act(async () => {
            await passThread();
        });
        expect(
            screen.queryByTestId("restored-session-banner")
        ).not.toBeInTheDocument();
    });

    it("starts in idle state when no snapshot exists", async () => {
        renderAudioDiary();
        await act(async () => {
            await passThread();
        });
        expect(screen.getByTestId("start-button")).toBeInTheDocument();
        expect(screen.getByText(/idle/i)).toBeInTheDocument();
    });
});

describe("AudioDiary persistence: restoring stopped state", () => {
    it("shows the session-restored banner when a stopped snapshot is loaded", async () => {
        const audioData = new TextEncoder().encode("saved-audio");
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 120,
            note: "my restored note",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(
                screen.getByTestId("restored-session-banner")
            ).toBeInTheDocument();
        });
    });

    it("restores the note text from a stopped snapshot", async () => {
        const audioData = new TextEncoder().encode("saved-audio");
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 30,
            note: "morning reflection",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("note-input")).toBeInTheDocument();
        });

        const noteInput = screen.getByTestId("note-input");
        expect(noteInput).toHaveValue("morning reflection");
    });

    it("shows the audio preview element for a restored stopped recording", async () => {
        const audioData = new TextEncoder().encode("saved-audio");
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 60,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("audio-preview")).toBeInTheDocument();
        });
    });

    it("shows the submit and discard buttons for a restored stopped recording", async () => {
        const audioData = new TextEncoder().encode("saved-audio");
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 45,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });
        expect(screen.getByTestId("discard-button")).toBeInTheDocument();
    });
});

describe("AudioDiary persistence: restoring in-progress (paused) state", () => {
    it("shows the session-restored banner for an in-progress snapshot", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "recording",
            elapsedSeconds: 75,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(
                screen.getByTestId("restored-session-banner")
            ).toBeInTheDocument();
        });
    });

    it("restores to paused state for a recording-state snapshot", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "recording",
            elapsedSeconds: 90,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByText(/⏸ Paused/i)).toBeInTheDocument();
        });
    });

    it("restores to paused state for a paused-state snapshot", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 40,
            note: "a thought",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByText(/⏸ Paused/i)).toBeInTheDocument();
        });
    });

    it("restores the elapsed timer value from a paused snapshot", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 137, // 02:17
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("timer")).toHaveTextContent("02:17");
        });
    });

    it("shows stop and discard controls after restoring an in-progress session", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "recording",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });
        expect(screen.getByTestId("discard-button")).toBeInTheDocument();
    });

    it("stopping a restored paused session produces an audio preview", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 50,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("audio-preview")).toBeInTheDocument();
        });
    });
});

describe("AudioDiary persistence: discard clears the snapshot", () => {
    it("hides the session-restored banner after discarding", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 20,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(
                screen.getByTestId("restored-session-banner")
            ).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("discard-button"));
        });

        await waitFor(() => {
            expect(
                screen.queryByTestId("restored-session-banner")
            ).not.toBeInTheDocument();
        });
    });

    it("returns to idle state after discarding a restored paused session", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 15,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("discard-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });

        expect(screen.getByText(/idle/i)).toBeInTheDocument();
    });
});

describe("AudioDiary persistence: submit clears the snapshot", () => {
    it("clears the stored snapshot after a successful submit", async () => {
        const audioData = new TextEncoder().encode("saved-audio");
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId("submit-button"));
        });

        await waitFor(() => {
            expect(mockNavigate).toHaveBeenCalledWith("/entry/entry-123");
        });

        // The snapshot should have been cleared from the store
        await act(async () => {
            await passThread();
        });
        expect(mockIDB.store.has("current")).toBe(false);
    });
});

describe("AudioDiary persistence: page visibility triggers save", () => {
    it("saves state when page becomes hidden during recording", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });

        // Simulate page becoming hidden
        Object.defineProperty(document, "visibilityState", {
            value: "hidden",
            writable: true,
            configurable: true,
        });
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });

        // Allow async save to complete
        await act(async () => {
            await passThread();
            await passThread();
        });

        // A snapshot should have been persisted
        expect(mockIDB.store.has("current")).toBe(true);

        // Restore visibility state
        Object.defineProperty(document, "visibilityState", {
            value: "visible",
            writable: true,
            configurable: true,
        });
    });

    it("does not save when recording is idle and page becomes hidden", async () => {
        renderAudioDiary();

        // Allow mount effects to settle
        await act(async () => {
            await passThread();
        });

        Object.defineProperty(document, "visibilityState", {
            value: "hidden",
            writable: true,
            configurable: true,
        });
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });

        await act(async () => {
            await passThread();
        });

        // No snapshot should be saved for idle state
        expect(mockIDB.store.has("current")).toBe(false);

        Object.defineProperty(document, "visibilityState", {
            value: "visible",
            writable: true,
            configurable: true,
        });
    });
});

describe("AudioDiary persistence: saving on pause", () => {
    it("saves a snapshot when the recording is paused", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("pause-resume-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("pause-resume-button"));
        });

        await waitFor(() => {
            expect(screen.getByText(/⏸ Paused/i)).toBeInTheDocument();
        });

        // Allow async save to complete
        await act(async () => {
            await passThread();
            await passThread();
        });

        expect(mockIDB.store.has("current")).toBe(true);
        const rawSnapshot = mockIDB.store.get("current");
        expect(rawSnapshot).toMatchObject({ recorderState: "paused" });
    });
});

describe("AudioDiary persistence: resuming from restored session", () => {
    it("starts a new recording when Resume is clicked on a restored paused session", async () => {
        const audioData = new TextEncoder().encode("partial-audio");
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: audioData.buffer,
        });

        renderAudioDiary();

        await waitFor(() => {
            expect(screen.getByTestId("pause-resume-button")).toBeInTheDocument();
        });

        // Resume button should be labeled "Resume recording"
        expect(
            screen.getByTestId("pause-resume-button")
        ).toHaveAttribute("aria-label", "Resume recording");

        await act(async () => {
            fireEvent.click(screen.getByTestId("pause-resume-button"));
        });

        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });

        // The timer should continue from the restored value (30s)
        expect(screen.getByTestId("timer")).toHaveTextContent("00:30");
    });
});
