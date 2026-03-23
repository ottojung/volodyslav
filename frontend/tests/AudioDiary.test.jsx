import React from "react";
import {
    render,
    screen,
    fireEvent,
    waitFor,
    act,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";

// ─── Mocks ──────────────────────────────────────────────────────────────────

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

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import AudioDiary from "../src/AudioDiary/AudioDiary.jsx";
import { submitEntry } from "../src/DescriptionEntry/api.js";

// ─── MediaRecorder mock ──────────────────────────────────────────────────────

/**
 * Minimal MediaRecorder stub that is controllable from tests.
 */
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

    stop() {
        this.state = "inactive";
        // Emit a data chunk and then trigger stop
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

// ─── getUserMedia mock ────────────────────────────────────────────────────────

/** @type {jest.Mock} */
let mockGetUserMedia;

/** @type {jest.Mock} */
let mockCreateObjectURL;

/** @type {jest.Mock} */
let mockRevokeObjectURL;

/** @type {typeof global.MediaRecorder | undefined} */
let originalMediaRecorder;
/** @type {typeof navigator.mediaDevices | undefined} */
let originalMediaDevices;
/** @type {typeof navigator.mediaDevices.getUserMedia | undefined} */
let originalGetUserMedia;
/** @type {typeof URL.createObjectURL} */
let originalCreateObjectURL;
/** @type {typeof URL.revokeObjectURL} */
let originalRevokeObjectURL;
/** @type {typeof HTMLCanvasElement.prototype.getContext} */
let originalCanvasGetContext;
/** @type {boolean} */
let hadMediaDevices;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {string} [initialPath]
 */
function renderAudioDiary(initialPath = "/record-diary") {
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

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
    originalMediaRecorder = global.MediaRecorder;
    originalMediaDevices = global.navigator.mediaDevices;
    hadMediaDevices = typeof originalMediaDevices !== "undefined";
    originalGetUserMedia = global.navigator.mediaDevices?.getUserMedia;
    originalCreateObjectURL = global.URL.createObjectURL;
    originalRevokeObjectURL = global.URL.revokeObjectURL;
    originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;

    // Mock MediaRecorder
    global.MediaRecorder = MockMediaRecorder;

    // Mock getUserMedia
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

    // Mock URL helpers
    mockCreateObjectURL = jest
        .fn()
        .mockReturnValue("blob:mock-url");
    mockRevokeObjectURL = jest.fn();
    global.URL.createObjectURL = mockCreateObjectURL;
    global.URL.revokeObjectURL = mockRevokeObjectURL;

    // Suppress HTMLMediaElement errors in jsdom
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
        () => Promise.resolve()
    );

    // Suppress canvas errors
    HTMLCanvasElement.prototype.getContext = jest.fn(() => null);
});

afterAll(() => {
    jest.restoreAllMocks();
    global.MediaRecorder = originalMediaRecorder;
    if (hadMediaDevices && originalMediaDevices) {
        // Restore getUserMedia on the original object before restoring the reference,
        // since beforeAll mutated the existing object's getUserMedia property.
        if (originalGetUserMedia !== undefined) {
            originalMediaDevices.getUserMedia = originalGetUserMedia;
        } else {
            delete originalMediaDevices.getUserMedia;
        }
        global.navigator.mediaDevices = originalMediaDevices;
    } else {
        delete global.navigator.mediaDevices;
    }
    global.URL.createObjectURL = originalCreateObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
});

beforeEach(() => {
    mockNavigate.mockClear();
    submitEntry.mockReset();
    mockGetUserMedia.mockClear();
    mockCreateObjectURL.mockClear();
    mockRevokeObjectURL.mockClear();
    MockMediaRecorder._instance = null;
    submitEntry.mockResolvedValue({ success: true, entry: { id: "entry-123" } });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AudioDiary page", () => {
    // ── Basic rendering ─────────────────────────────────────────────────────

    it("renders the Record Diary heading", () => {
        renderAudioDiary();
        expect(screen.getByText("Record Diary")).toBeInTheDocument();
    });

    it("shows the Start Recording button in idle state", () => {
        renderAudioDiary();
        expect(screen.getByTestId("start-button")).toBeInTheDocument();
    });

    it("shows idle state label initially", () => {
        renderAudioDiary();
        expect(screen.getByText(/idle/i)).toBeInTheDocument();
    });

    // ── Recorder state transitions ───────────────────────────────────────────

    it("transitions from idle to recording after clicking Start Recording", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true });
        });

        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });
    });

    it("shows Pause and Stop buttons while recording", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("pause-resume-button")).toBeInTheDocument();
        });

        expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        expect(screen.getByTestId("discard-button")).toBeInTheDocument();
    });

    it("transitions to paused state when Pause is clicked", async () => {
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
    });

    it("shows Resume button when paused, and resumes on click", async () => {
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
            expect(screen.getByTestId("pause-resume-button")).toHaveAttribute(
                "aria-label",
                "Resume recording"
            );
        });

        act(() => {
            fireEvent.click(screen.getByTestId("pause-resume-button"));
        });

        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });
    });

    it("transitions to stopped state when Stop is clicked", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByText(/■ Stopped/i)).toBeInTheDocument();
        });
    });

    it("discarding from recording resets to idle", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("discard-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("discard-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });

        expect(screen.getByText(/idle/i)).toBeInTheDocument();
    });

    it("discarding from stopped state resets to idle", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("discard-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("discard-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });
    });

    // ── Audio blob assembly ─────────────────────────────────────────────────

    it("stopping recording produces an audio preview element", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("audio-preview")).toBeInTheDocument();
        });

        expect(mockCreateObjectURL).toHaveBeenCalled();
        const audioEl = screen.getByTestId("audio-preview");
        expect(audioEl).toHaveAttribute("src", "blob:mock-url");
    });

    it("stopping recording combines collected chunks into one Blob", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });

        // The blob passed to createObjectURL should be a Blob
        const call = mockCreateObjectURL.mock.calls[0];
        expect(call[0]).toBeInstanceOf(Blob);
    });

    // ── Submission ───────────────────────────────────────────────────────────

    it("submit calls submitEntry with diary [audiorecording] and one audio File", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId("submit-button"));
        });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledTimes(1);
        });

        const [rawInput, _reqId, files] = submitEntry.mock.calls[0];
        expect(rawInput).toBe("diary [audiorecording]");
        expect(_reqId).toBeUndefined();
        expect(Array.isArray(files)).toBe(true);
        expect(files).toHaveLength(1);
        expect(files[0]).toBeInstanceOf(File);
    });

    it("submitted audio file has webm extension and audio/webm MIME type", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId("submit-button"));
        });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledTimes(1);
        });

        const [, , files] = submitEntry.mock.calls[0];
        expect(files[0].name).toBe("diary-recording.webm");
        expect(files[0].type).toMatch(/^audio\/webm/);
    });

    it("submit with a note includes the note in rawInput", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("note-input")).toBeInTheDocument();
        });

        fireEvent.change(screen.getByTestId("note-input"), {
            target: { value: "morning reflection" },
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId("submit-button"));
        });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledTimes(1);
        });

        const [rawInput] = submitEntry.mock.calls[0];
        expect(rawInput).toBe("diary [audiorecording] morning reflection");
    });

    it("successful submit navigates to the created entry detail page", async () => {
        submitEntry.mockResolvedValue({
            success: true,
            entry: { id: "abc-123" },
        });

        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId("submit-button"));
        });

        await waitFor(() => {
            expect(mockNavigate).toHaveBeenCalledWith("/entry/abc-123");
        });
    });

    it("submit failure shows an error message", async () => {
        submitEntry.mockRejectedValue(new Error("Network error"));

        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        });

        act(() => {
            fireEvent.click(screen.getByTestId("stop-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId("submit-button"));
        });

        await waitFor(() => {
            expect(screen.getByText(/Submission failed/i)).toBeInTheDocument();
        });

        expect(mockNavigate).not.toHaveBeenCalled();
    });

    // ── Microphone permission failure ────────────────────────────────────────

    it("shows an error when microphone access is denied", async () => {
        mockGetUserMedia.mockRejectedValueOnce(
            new Error("Permission denied")
        );

        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(
                screen.getByText(/Microphone access denied or unavailable/i)
            ).toBeInTheDocument();
        });

        // Should remain idle (start button still present)
        expect(screen.getByTestId("start-button")).toBeInTheDocument();
    });

    // ── Unsupported browser ──────────────────────────────────────────────────

    it("shows an error when MediaRecorder constructor throws", async () => {
        const OriginalMock = global.MediaRecorder;
        try {
            Object.defineProperty(global, "MediaRecorder", {
                value: class {
                    static isTypeSupported() {
                        return false;
                    }

                    constructor() {
                        throw new Error("MediaRecorder not supported");
                    }
                },
                configurable: true,
                writable: true,
            });

            renderAudioDiary();

            await act(async () => {
                fireEvent.click(screen.getByTestId("start-button"));
            });

            await waitFor(() => {
                expect(
                    screen.getByText(/MediaRecorder is not supported/i)
                ).toBeInTheDocument();
            });
        } finally {
            global.MediaRecorder = OriginalMock;
        }
    });

    it("shows unsupported-browser error when MediaRecorder is unavailable", async () => {
        const originalMediaRecorderLocal = global.MediaRecorder;
        try {
            Object.defineProperty(global, "MediaRecorder", {
                value: undefined,
                configurable: true,
                writable: true,
            });

            renderAudioDiary();

            await act(async () => {
                fireEvent.click(screen.getByTestId("start-button"));
            });

            await waitFor(() => {
                expect(
                    screen.getByText(/MediaRecorder is not supported/i)
                ).toBeInTheDocument();
            });
        } finally {
            Object.defineProperty(global, "MediaRecorder", {
                value: originalMediaRecorderLocal,
                configurable: true,
                writable: true,
            });
        }
    });

    // ── Timer ────────────────────────────────────────────────────────────────

    it("shows a timer while recording", async () => {
        jest.useFakeTimers();
        try {
            renderAudioDiary();

            await act(async () => {
                fireEvent.click(screen.getByTestId("start-button"));
            });

            await waitFor(() => {
                expect(screen.getByTestId("timer")).toBeInTheDocument();
            });

            act(() => {
                jest.advanceTimersByTime(3000);
            });

            await waitFor(() => {
                expect(screen.getByTestId("timer")).toHaveTextContent("00:03");
            });
        } finally {
            jest.useRealTimers();
        }
    });

    // ── Icon buttons ─────────────────────────────────────────────────────────

    it("start button has aria-label 'Start recording'", () => {
        renderAudioDiary();
        expect(screen.getByTestId("start-button")).toHaveAttribute(
            "aria-label",
            "Start recording"
        );
    });

    it("shows pause icon button with aria-label 'Pause recording' while recording", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("pause-resume-button")).toHaveAttribute(
                "aria-label",
                "Pause recording"
            );
        });
    });

    it("stop button has aria-label 'Stop recording' while recording", async () => {
        renderAudioDiary();

        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });

        await waitFor(() => {
            expect(screen.getByTestId("stop-button")).toHaveAttribute(
                "aria-label",
                "Stop recording"
            );
        });
    });

    it("shows resume icon button with aria-label 'Resume recording' while paused", async () => {
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
            expect(screen.getByTestId("pause-resume-button")).toHaveAttribute(
                "aria-label",
                "Resume recording"
            );
        });
    });

    it("shows 'Tap the microphone to start' hint in idle state", () => {
        renderAudioDiary();
        expect(
            screen.getByText(/Tap the microphone to start/i)
        ).toBeInTheDocument();
    });
});
