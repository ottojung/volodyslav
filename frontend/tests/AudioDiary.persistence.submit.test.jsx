import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../src/DescriptionEntry/api.js", () => ({
    submitEntry: jest.fn(),
}));
jest.mock("../src/DescriptionEntry/logger.js", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { submitEntry } from "../src/DescriptionEntry/api.js";
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
    it("clears stored session ID after successful submit", async () => {
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
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
        await act(async () => { await passThread(); });
        expect(currentStore().has("audioDiarySessionId")).toBe(false);
    });

    it("keeps session ID when submit fails", async () => {
        submitEntry.mockRejectedValueOnce(new Error("network fail"));
        injectSnapshot({
            recorderState: "stopped",
            elapsedSeconds: 30,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
        });
        renderAudioDiary();
        await waitFor(() => {
            expect(screen.getByTestId("submit-button")).toBeInTheDocument();
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId("submit-button"));
        });
        await waitFor(() => {
            expect(screen.getByText(/Submission failed/i)).toBeInTheDocument();
        });
        expect(currentStore().has("audioDiarySessionId")).toBe(true);
    });
});
