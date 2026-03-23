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
            await passThread();
            await passThread();
        });
        expect(currentStore().has("current")).toBe(true);
        const rawSnapshot = currentStore().get("current");
        expect(rawSnapshot).toBeTruthy();
        expect(typeof rawSnapshot?.mimeType).toBe("string");
        expect(rawSnapshot?.mimeType).toContain("audio/");
        Object.defineProperty(document, "visibilityState", {
            value: "visible",
            writable: true,
            configurable: true,
        });
    });

    it("does not persist when idle and hidden", async () => {
        renderAudioDiary();
        await act(async () => {
            await passThread();
            await passThread();
        });
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

    it("saves state on pagehide while recording", async () => {
        renderAudioDiary();
        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });
        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });
        act(() => {
            window.dispatchEvent(new Event("pagehide"));
        });
        await act(async () => {
            await passThread();
            await passThread();
            await passThread();
            await passThread();
        });
        expect(currentStore().has("current")).toBe(true);
    });

    it("saves state on beforeunload while recording", async () => {
        renderAudioDiary();
        await act(async () => {
            fireEvent.click(screen.getByTestId("start-button"));
        });
        await waitFor(() => {
            expect(screen.getByText(/● Recording/i)).toBeInTheDocument();
        });
        act(() => {
            window.dispatchEvent(new Event("beforeunload"));
        });
        await act(async () => {
            await passThread();
            await passThread();
            await passThread();
            await passThread();
        });
        expect(currentStore().has("current")).toBe(true);
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

    it("clears stale persisted snapshot before starting a new recording", async () => {
        renderAudioDiary();
        await act(async () => {
            await passThread();
        });
        currentStore().set("current", {
            recorderState: "paused",
            elapsedSeconds: 99,
            note: "stale",
            mimeType: "audio/ogg",
            audioBuffer: new TextEncoder().encode("stale").buffer,
        });
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
        expect(currentStore().has("current")).toBe(false);
        Object.defineProperty(global.navigator, "mediaDevices", {
            value: originalMediaDevices,
            writable: true,
            configurable: true,
        });
    });
});
