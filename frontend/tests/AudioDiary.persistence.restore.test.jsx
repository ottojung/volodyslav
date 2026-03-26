import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../src/DescriptionEntry/api.js", () => ({
    submitEntry: jest.fn(),
}));
jest.mock("../src/DescriptionEntry/logger.js", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
    injectSnapshot,
    passThread,
    renderAudioDiary,
    setupAudioDiaryPersistenceHarness,
} from "./AudioDiary.persistence.helpers.jsx";

setupAudioDiaryPersistenceHarness();

describe("AudioDiary persistence: restore states", () => {
    it("does not show banner when no snapshot exists", async () => {
        renderAudioDiary();
        await act(async () => { await passThread(); });
        expect(screen.queryByTestId("restored-session-banner")).not.toBeInTheDocument();
        expect(screen.getByText(/idle/i)).toBeInTheDocument();
    });

    it("restores stopped session with audio preview and submit button", async () => {
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
        });
        renderAudioDiary();
        await waitFor(() => {
            expect(screen.getByTestId("restored-session-banner")).toBeInTheDocument();
        });
        await waitFor(() => {
            expect(screen.getByTestId("audio-preview")).toBeInTheDocument();
        });
        expect(screen.getByTestId("submit-button")).toBeInTheDocument();
    });

    it("restores recording/paused snapshot into paused state and timer", async () => {
        injectSnapshot({
            recorderState: "recording",
            elapsedSeconds: 137,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
        });
        renderAudioDiary();
        await waitFor(() => {
            expect(screen.getByText(/⏸ Paused/i)).toBeInTheDocument();
        });
        expect(screen.getByTestId("timer")).toHaveTextContent("02:17");
        expect(screen.getByTestId("stop-button")).toBeInTheDocument();
        expect(screen.getByTestId("discard-button")).toBeInTheDocument();
    });

    it("stop from restored paused shows preview", async () => {
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 50,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
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

    it("resume from restored paused transitions to recording and keeps timer base", async () => {
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
        });
        renderAudioDiary();
        await waitFor(() => {
            expect(screen.getByTestId("pause-resume-button")).toBeInTheDocument();
        });
        expect(screen.getByTestId("pause-resume-button")).toHaveAttribute(
            "aria-label",
            "Resume recording"
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId("pause-resume-button"));
        });
        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });
        expect(screen.getByTestId("timer")).toHaveTextContent("00:30");
    });
});
