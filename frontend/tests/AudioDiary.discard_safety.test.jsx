import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";

jest.mock("../src/AudioDiary/diary_audio_api.js", () => ({
    submitDiaryAudio: jest.fn(),
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

import AudioDiary from "../src/AudioDiary/AudioDiary.jsx";
import DiscardControl from "../src/AudioDiary/DiscardControl.jsx";

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

/** @type {jest.Mock} */
let mockGetUserMedia;
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
/** @type {boolean} */
let hadMediaDevices;

/**
 * @param {string} [initialPath]
 * @returns {import("@testing-library/react").RenderResult}
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

beforeAll(() => {
    originalMediaRecorder = global.MediaRecorder;
    originalMediaDevices = global.navigator.mediaDevices;
    hadMediaDevices = typeof originalMediaDevices !== "undefined";
    originalGetUserMedia = global.navigator.mediaDevices?.getUserMedia;
    originalCreateObjectURL = global.URL.createObjectURL;
    originalRevokeObjectURL = global.URL.revokeObjectURL;

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
    jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
        () => Promise.resolve()
    );
    HTMLCanvasElement.prototype.getContext = jest.fn(() => null);
});

afterAll(() => {
    jest.restoreAllMocks();
    global.MediaRecorder = originalMediaRecorder;
    if (hadMediaDevices && originalMediaDevices) {
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
});

beforeEach(() => {
    mockNavigate.mockClear();
    mockGetUserMedia.mockClear();
    MockMediaRecorder._instance = null;
});

/**
 * Drive the page into the recording state.
 * @returns {Promise<void>}
 */
async function startRecording() {
    await act(async () => {
        fireEvent.click(screen.getByTestId("start-button"));
    });
    await waitFor(() => {
        expect(screen.getByTestId("stop-button")).toBeInTheDocument();
    });
}

/**
 * Drive the page into the stopped-with-preview state.
 * @returns {Promise<void>}
 */
async function stopRecording() {
    act(() => {
        fireEvent.click(screen.getByTestId("stop-button"));
    });
    await waitFor(() => {
        expect(screen.getByTestId("discard-button")).toBeInTheDocument();
    });
}

describe("Discard two-step confirmation in AudioDiary", () => {
    it("does not discard an in-progress recording on the first press", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));

        // The first press arms a confirmation instead of destroying anything.
        expect(screen.getByTestId("discard-confirmation")).toBeInTheDocument();
        expect(
            screen.queryByTestId("start-button")
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        expect(screen.getByTestId("timer")).toBeInTheDocument();
    });

    it("names the irreversible consequence in the confirmation", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));

        expect(
            screen.getByText(/discard this recording\? it cannot be recovered\./i)
        ).toBeInTheDocument();
    });

    it("discards once the confirmation is confirmed", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.click(screen.getByTestId("discard-confirm-button"));

        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });
        expect(
            screen.queryByTestId("discard-confirmation")
        ).not.toBeInTheDocument();
    });

    it("keeps the recording when the keep control is pressed", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.click(screen.getByTestId("discard-keep-button"));

        expect(
            screen.queryByTestId("discard-confirmation")
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("discard-button")).toBeInTheDocument();
        expect(screen.getByTestId("stop-button")).toBeInTheDocument();
    });

    it("keeps the recording when Escape is pressed", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        expect(screen.getByTestId("discard-confirmation")).toBeInTheDocument();

        fireEvent.keyDown(window, { key: "Escape" });

        expect(
            screen.queryByTestId("discard-confirmation")
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("stop-button")).toBeInTheDocument();
    });

    it("keeps the recording when Escape dismisses and the trigger is pressed again", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.keyDown(window, { key: "Escape" });
        fireEvent.click(screen.getByTestId("discard-button"));

        expect(screen.getByTestId("discard-confirmation")).toBeInTheDocument();
        expect(screen.getByTestId("stop-button")).toBeInTheDocument();
    });

    it("voids an armed confirmation when the recorder changes state", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        expect(screen.getByTestId("discard-confirmation")).toBeInTheDocument();

        // Pausing moves to a different recording state, which invalidates a
        // confirmation that was armed about the previous one.
        act(() => {
            fireEvent.click(screen.getByTestId("pause-resume-button"));
        });

        expect(
            screen.queryByTestId("discard-confirmation")
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("discard-button")).toBeInTheDocument();
    });

    it("guards the preview-state discard as well", async () => {
        renderAudioDiary();
        await startRecording();
        await stopRecording();

        fireEvent.click(screen.getByTestId("discard-button"));

        expect(screen.getByTestId("discard-confirmation")).toBeInTheDocument();
        // The recording survives the first press: preview and submit remain.
        expect(screen.getByTestId("audio-preview")).toBeInTheDocument();
        expect(screen.getByTestId("submit-button")).toBeInTheDocument();
    });

    it("leaves the preview-state submit button room when the confirmation opens", async () => {
        renderAudioDiary();
        await startRecording();
        await stopRecording();

        const submitButton = screen.getByTestId("submit-button");
        const submitWidthBefore = submitButton.getBoundingClientRect().width;

        fireEvent.click(screen.getByTestId("discard-button"));

        const confirmation = screen.getByTestId("discard-confirmation");
        // The confirmation grows into the row rather than claiming all of it.
        expect(getComputedStyle(confirmation).flexGrow).toBe("1");
        expect(
            submitButton.getBoundingClientRect().width
        ).toBeCloseTo(submitWidthBefore, 5);
    });

    it("restores focus to the discard trigger after Escape in the preview state", async () => {
        renderAudioDiary();
        await startRecording();
        await stopRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        expect(screen.getByTestId("discard-keep-button")).toHaveFocus();

        fireEvent.keyDown(window, { key: "Escape" });

        expect(screen.getByTestId("discard-button")).toHaveFocus();
    });

    it("restores focus to the discard trigger after Escape while recording", async () => {
        renderAudioDiary();
        await startRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.keyDown(window, { key: "Escape" });

        expect(screen.getByTestId("discard-button")).toHaveFocus();
    });

    it("discards from the preview state once confirmed", async () => {
        renderAudioDiary();
        await startRecording();
        await stopRecording();

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.click(screen.getByTestId("discard-confirm-button"));

        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });
    });
});

describe("DiscardControl confirmation state", () => {
    it("focuses the keep control so Enter does not discard", () => {
        const onDiscard = jest.fn();
        render(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={onDiscard} subject="a" layout="full" />
            </ChakraProvider>
        );

        fireEvent.click(screen.getByTestId("discard-button"));

        expect(screen.getByTestId("discard-keep-button")).toHaveFocus();
    });

    it("re-arms cleanly after a dismissed confirmation", () => {
        const onDiscard = jest.fn();
        render(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={onDiscard} subject="a" layout="flex" />
            </ChakraProvider>
        );

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.click(screen.getByTestId("discard-keep-button"));
        expect(onDiscard).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.click(screen.getByTestId("discard-confirm-button"));
        expect(onDiscard).toHaveBeenCalledTimes(1);
    });

    it("sizes the armed confirmation to share the row on the flex layout", () => {
        render(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={jest.fn()} subject="a" layout="flex" />
            </ChakraProvider>
        );

        fireEvent.click(screen.getByTestId("discard-button"));

        const confirmation = screen.getByTestId("discard-confirmation");
        // Shares the row with its sibling action instead of claiming the row.
        expect(getComputedStyle(confirmation).flexGrow).toBe("1");
        expect(getComputedStyle(confirmation).flexDirection).toBe("row");
    });

    it("spans the column for the armed confirmation on the full layout", () => {
        render(
            <ChakraProvider value={defaultSystem}>
                <div style={{ width: "320px" }}>
                    <DiscardControl
                        onDiscard={jest.fn()}
                        subject="a"
                        layout="full"
                    />
                </div>
            </ChakraProvider>
        );

        fireEvent.click(screen.getByTestId("discard-button"));

        const confirmation = screen.getByTestId("discard-confirmation");
        expect(getComputedStyle(confirmation).flexDirection).toBe("column");
        // It fills the column exactly as the trigger does, and does not grow
        // into a row the way the flex layout's confirmation does.
        expect(getComputedStyle(confirmation).width).toBe(
            "var(--chakra-sizes-full)"
        );
        expect(getComputedStyle(confirmation).flexGrow).not.toBe("1");
    });

    it("restores focus to the trigger when Escape dismisses the confirmation", () => {
        render(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={jest.fn()} subject="a" layout="full" />
            </ChakraProvider>
        );

        const trigger = screen.getByTestId("discard-button");
        fireEvent.click(trigger);
        expect(screen.getByTestId("discard-keep-button")).toHaveFocus();

        fireEvent.keyDown(window, { key: "Escape" });

        expect(screen.getByTestId("discard-button")).toHaveFocus();
    });

    it("restores focus to the trigger when the keep control is pressed", () => {
        render(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={jest.fn()} subject="a" layout="full" />
            </ChakraProvider>
        );

        fireEvent.click(screen.getByTestId("discard-button"));
        fireEvent.click(screen.getByTestId("discard-keep-button"));

        expect(screen.getByTestId("discard-button")).toHaveFocus();
    });

    it("restores focus to the trigger when the subject changes", () => {
        const onDiscard = jest.fn();
        const { rerender } = render(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={onDiscard} subject="a" layout="full" />
            </ChakraProvider>
        );

        fireEvent.click(screen.getByTestId("discard-button"));

        rerender(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={onDiscard} subject="b" layout="full" />
            </ChakraProvider>
        );

        expect(screen.getByTestId("discard-button")).toHaveFocus();
    });

    it("drops an armed confirmation when the subject changes", () => {
        const onDiscard = jest.fn();
        const { rerender } = render(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={onDiscard} subject="a" layout="full" />
            </ChakraProvider>
        );

        fireEvent.click(screen.getByTestId("discard-button"));
        expect(screen.getByTestId("discard-confirmation")).toBeInTheDocument();

        rerender(
            <ChakraProvider value={defaultSystem}>
                <DiscardControl onDiscard={onDiscard} subject="b" layout="full" />
            </ChakraProvider>
        );

        expect(
            screen.queryByTestId("discard-confirmation")
        ).not.toBeInTheDocument();
        expect(onDiscard).not.toHaveBeenCalled();
    });
});
