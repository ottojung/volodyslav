import React from "react";
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
    it("clears stored snapshot after successful submit", async () => {
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
        await act(async () => { await passThread(); });
        expect(currentStore().has("current")).toBe(false);
    });

    it("keeps snapshot when submit fails", async () => {
        submitEntry.mockRejectedValueOnce(new Error("network fail"));
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
            expect(screen.getByText(/Submission failed/i)).toBeInTheDocument();
        });
        expect(currentStore().has("current")).toBe(true);
    });
});
