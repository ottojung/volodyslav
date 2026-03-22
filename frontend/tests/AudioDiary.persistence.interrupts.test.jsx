import React from "react";
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
    it("saves state when page becomes hidden while recording", async () => {
        renderAudioDiary();
        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });
        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
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
            await passThread();
        });
        expect(currentStore().has("current")).toBe(true);
        Object.defineProperty(document, "visibilityState", {
            value: "visible",
            writable: true,
            configurable: true,
        });
    });

    it("does not persist when idle and hidden", async () => {
        renderAudioDiary();
        await act(async () => { await passThread(); });
        Object.defineProperty(document, "visibilityState", {
            value: "hidden",
            writable: true,
            configurable: true,
        });
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await act(async () => { await passThread(); });
        expect(currentStore().has("current")).toBe(false);
        Object.defineProperty(document, "visibilityState", {
            value: "visible",
            writable: true,
            configurable: true,
        });
    });

    it("saves on pause", async () => {
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
        await act(async () => {
            await passThread();
            await passThread();
        });
        expect(currentStore().has("current")).toBe(true);
        const rawSnapshot = currentStore().get("current");
        expect(rawSnapshot).toMatchObject({ recorderState: "paused" });
    });

    it("discard clears restored banner and returns idle", async () => {
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
});
