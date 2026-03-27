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
        // Override the fetch mock to fail for diary-audio
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockImplementation((url, options) => {
            const urlStr = String(url);
            if (options && options.method === "POST" && urlStr.includes("/entries/diary-audio")) {
                return Promise.resolve({
                    ok: false,
                    status: 500,
                    json: () => Promise.resolve({ error: "network fail" }),
                    blob: () => Promise.resolve(new Blob()),
                });
            }
            return originalFetch(url, options);
        });

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
