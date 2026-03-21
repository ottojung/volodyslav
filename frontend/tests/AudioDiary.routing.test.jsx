/**
 * Tests for AudioDiary route registration and home-page navigation.
 */

import React from "react";
import {
    render,
    screen,
    fireEvent,
    waitFor,
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

jest.mock("../src/Sync/api.js", () => ({
    postSync: jest.fn(),
    fetchSyncHostnames: jest.fn().mockResolvedValue([]),
}));

jest.mock("../src/version_api.js", () => ({
    fetchVersion: jest.fn().mockResolvedValue("1.0.0"),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import App from "../src/App.jsx";
import AudioDiary from "../src/AudioDiary/AudioDiary.jsx";

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let originalMediaRecorder;
let originalMediaDevices;
let hadMediaDevices;
let mockGetUserMedia;
let originalGetUserMedia;

beforeAll(() => {
    originalMediaRecorder = global.MediaRecorder;
    originalMediaDevices = global.navigator.mediaDevices;
    hadMediaDevices = typeof originalMediaDevices !== "undefined";
    originalGetUserMedia = global.navigator.mediaDevices?.getUserMedia;

    const MockMR = class {
        constructor() {
            this.state = "inactive";
            this.ondataavailable = null;
            this.onstop = null;
            this.onerror = null;
        }
        start() { this.state = "recording"; }
        pause() { this.state = "paused"; }
        resume() { this.state = "recording"; }
        stop() { this.state = "inactive"; if (this.onstop) this.onstop(); }
    };
    MockMR.isTypeSupported = jest.fn(() => true);
    global.MediaRecorder = MockMR;

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
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterAll(() => {
    jest.restoreAllMocks();
    global.MediaRecorder = originalMediaRecorder;
    if (hadMediaDevices && originalMediaDevices) {
        // Restore getUserMedia on the original object before restoring reference,
        // since beforeAll may have mutated it.
        if (originalGetUserMedia !== undefined) {
            originalMediaDevices.getUserMedia = originalGetUserMedia;
        } else {
            delete originalMediaDevices.getUserMedia;
        }
        global.navigator.mediaDevices = originalMediaDevices;
    } else {
        delete global.navigator.mediaDevices;
    }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderWithRouter(initialPath = "/") {
    return render(
        <ChakraProvider>
            <MemoryRouter initialEntries={[initialPath]}>
                <Routes>
                    <Route path="/" element={<App />} />
                    <Route path="/record-diary" element={<AudioDiary />} />
                    <Route path="/camera" element={<div>Camera page</div>} />
                    <Route path="/describe" element={<div>Describe page</div>} />
                    <Route path="/search" element={<div>Search page</div>} />
                    <Route path="/config" element={<div>Config page</div>} />
                </Routes>
            </MemoryRouter>
        </ChakraProvider>
    );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AudioDiary routing", () => {
    it("home page has a Record Diary button", async () => {
        renderWithRouter("/");
        await waitFor(() => {
            expect(screen.getByText("Record Diary")).toBeInTheDocument();
        });
    });

    it("clicking Record Diary button navigates to /record-diary page", async () => {
        renderWithRouter("/");
        await waitFor(() => {
            expect(screen.getByText("Record Diary")).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText("Record Diary"));

        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });
    });

    it("navigating directly to /record-diary renders the AudioDiary page", async () => {
        renderWithRouter("/record-diary");
        await waitFor(() => {
            expect(screen.getByText("Record Diary")).toBeInTheDocument();
        });
        expect(screen.getByTestId("start-button")).toBeInTheDocument();
    });
});
