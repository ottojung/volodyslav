import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../src/DescriptionEntry/api.js", () => ({
    submitEntry: jest.fn(),
}));
jest.mock("../src/DescriptionEntry/logger.js", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
    currentStore,
    injectSnapshot,
    passThread,
    renderAudioDiary,
    setupAudioDiaryPersistenceHarness,
} from "./AudioDiary.persistence.helpers.jsx";

setupAudioDiaryPersistenceHarness();

describe("AudioDiary persistence: interrupt handling", () => {
    it("sessionId is stored in localStorage when recording starts", async () => {
        renderAudioDiary();
        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });
        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });
        expect(currentStore().has("audioDiarySessionId")).toBe(true);
        expect(currentStore().get("audioDiarySessionId")).toBeTruthy();
    });

    it("does not have sessionId in localStorage when idle", async () => {
        renderAudioDiary();
        await act(async () => {
            await passThread();
            await passThread();
        });
        expect(currentStore().has("audioDiarySessionId")).toBe(false);
    });

    it("discard clears restored banner and returns idle", async () => {
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 15,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
        });
        renderAudioDiary();
        await waitFor(() => {
            expect(screen.getByTestId("restored-session-banner")).toBeInTheDocument();
        });
        act(() => {
            fireEvent.click(screen.getByTestId("discard-button"));
        });
        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });
        expect(screen.queryByTestId("restored-session-banner")).not.toBeInTheDocument();
        expect(screen.getByText(/idle/i)).toBeInTheDocument();
    });

    it("discard clears sessionId from localStorage", async () => {
        injectSnapshot({
            recorderState: "paused",
            elapsedSeconds: 15,
            note: "",
            mimeType: "audio/webm",
            audioBuffer: new ArrayBuffer(0),
        });
        renderAudioDiary();
        await waitFor(() => {
            expect(screen.getByTestId("discard-button")).toBeInTheDocument();
        });
        act(() => {
            fireEvent.click(screen.getByTestId("discard-button"));
        });
        await waitFor(() => {
            expect(screen.getByTestId("start-button")).toBeInTheDocument();
        });
        expect(currentStore().has("audioDiarySessionId")).toBe(false);
    });

    it("clears sessionId before starting a new recording", async () => {
        renderAudioDiary();
        await act(async () => {
            await passThread();
        });
        // Manually set a stale session ID
        currentStore().set("audioDiarySessionId", "stale-session-id");

        const originalMediaDevices = global.navigator.mediaDevices;
        Object.defineProperty(global.navigator, "mediaDevices", {
            value: undefined,
            writable: true,
            configurable: true,
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
            await passThread();
            await passThread();
        });
        // A new session ID should be set (different from stale one)
        // OR the stale one gets cleared and a new one is set
        const storedId = currentStore().get("audioDiarySessionId");
        expect(storedId).not.toBe("stale-session-id");
        Object.defineProperty(global.navigator, "mediaDevices", {
            value: originalMediaDevices,
            writable: true,
            configurable: true,
        });
    });
});
