import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../src/DescriptionEntry/logger.js", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
    currentStore,
    injectSnapshot,
    passThread,
    renderAudioDiary,
    setupAudioDiaryPersistenceHarness,
    mockNavigate,
} from "./AudioDiary.persistence.helpers.jsx";

setupAudioDiaryPersistenceHarness();

describe("AudioDiary persistence: submit lifecycle", () => {
    it("restored stopped session does not show submit button", async () => {
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
        await act(async () => { await passThread(); });
        expect(screen.queryByTestId("submit-button")).not.toBeInTheDocument();
        expect(screen.getByText(/■ Stopped/i)).toBeInTheDocument();
        expect(currentStore().has("audioDiarySessionId")).toBe(true);
    });

    it("restored stopped session: session ID persists until new recording starts", async () => {
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
        });
        renderAudioDiary();
        await waitFor(() => {
            expect(screen.getByText(/■ Stopped/i)).toBeInTheDocument();
        });
        // Session ID remains in localStorage since user hasn't re-recorded or submitted
        expect(currentStore().has("audioDiarySessionId")).toBe(true);
    });
});
