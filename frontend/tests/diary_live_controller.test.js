/**
 * Tests for useDiaryLiveQuestioningController.
 */

import { renderHook, act } from "@testing-library/react";

// Mock the API module before importing the hook.
jest.mock("../src/AudioDiary/diary_live_api.js", () => ({
    pushAudio: jest.fn(),
}));

import { useDiaryLiveQuestioningController } from "../src/AudioDiary/useDiaryLiveQuestioningController.js";
import { pushAudio } from "../src/AudioDiary/diary_live_api.js";

function makeBlob(content = "audio") {
    return new Blob([content], { type: "audio/webm" });
}

beforeEach(() => {
    jest.clearAllMocks();
    // Default: server returns no questions.
    pushAudio.mockResolvedValue({ questions: [] });
});

// ─── startLive / stopLive ─────────────────────────────────────────────────────

describe("startLive", () => {
    it("resets displayedGenerations and liveErrorMessage", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive("sess-1", "audio/webm"));

        expect(result.current.displayedGenerations).toEqual([]);
        expect(result.current.liveErrorMessage).toBeNull();
    });
});

describe("stopLive", () => {
    it("ignores fragments sent after stopLive is called", async () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive("sess-stop", "audio/webm"));
        act(() => result.current.stopLive());

        await act(async () => {
            await result.current.onFragment(makeBlob(), 0, 10000);
        });

        // pushAudio should NOT have been called after stop.
        expect(pushAudio).not.toHaveBeenCalled();
    });
});

// ─── onFragment ───────────────────────────────────────────────────────────────

describe("onFragment", () => {
    it("calls pushAudio with sessionId, mimeType, and an incrementing fragmentNumber", async () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive("sess-a", "audio/ogg"));

        await act(async () => {
            await result.current.onFragment(makeBlob("f1"), 0, 10000);
        });

        expect(pushAudio).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "sess-a",
                fragmentNumber: 1,
            })
        );

        await act(async () => {
            await result.current.onFragment(makeBlob("f2"), 10000, 20000);
        });

        expect(pushAudio).toHaveBeenCalledWith(
            expect.objectContaining({
                fragmentNumber: 2,
            })
        );
    });

    it("adds a QuestionGeneration when the server returns questions", async () => {
        pushAudio.mockResolvedValue({
            questions: [
                { text: "How did that make you feel?", intent: "warm_reflective" },
            ],
        });

        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("sess-q", "audio/webm"));

        await act(async () => {
            await result.current.onFragment(makeBlob(), 0, 10000);
        });

        expect(result.current.displayedGenerations).toHaveLength(1);
        expect(result.current.displayedGenerations[0].questions[0].text).toBe(
            "How did that make you feel?"
        );
    });

    it("does not add a generation when the server returns empty questions", async () => {
        pushAudio.mockResolvedValue({ questions: [] });

        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("sess-noq", "audio/webm"));

        await act(async () => {
            await result.current.onFragment(makeBlob(), 0, 10000);
        });

        expect(result.current.displayedGenerations).toHaveLength(0);
    });

    it("sets liveErrorMessage when pushAudio rejects", async () => {
        pushAudio.mockRejectedValue(new Error("network error"));

        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("sess-err", "audio/webm"));

        await act(async () => {
            await result.current.onFragment(makeBlob(), 0, 10000);
        });

        expect(result.current.liveErrorMessage).not.toBeNull();
    });

    it("clears liveErrorMessage after a successful call", async () => {
        pushAudio
            .mockRejectedValueOnce(new Error("transient error"))
            .mockResolvedValue({ questions: [] });

        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("sess-recover", "audio/webm"));

        // First call: fails.
        await act(async () => {
            await result.current.onFragment(makeBlob(), 0, 10000);
        });
        expect(result.current.liveErrorMessage).not.toBeNull();

        // Second call: succeeds.
        await act(async () => {
            await result.current.onFragment(makeBlob(), 10000, 20000);
        });
        expect(result.current.liveErrorMessage).toBeNull();
    });

    it("trims displayed generations to MAX_VISIBLE_GENERATIONS (4)", async () => {
        pushAudio.mockResolvedValue({
            questions: [{ text: "A question", intent: "clarifying" }],
        });

        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("sess-trim", "audio/webm"));

        for (let i = 0; i < 6; i++) {
            await act(async () => {
                await result.current.onFragment(makeBlob(), i * 10000, (i + 1) * 10000);
            });
        }

        expect(result.current.displayedGenerations.length).toBeLessThanOrEqual(4);
    });

    it("ignores the fragment if called before startLive", async () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        await act(async () => {
            await result.current.onFragment(makeBlob(), 0, 10000);
        });

        expect(pushAudio).not.toHaveBeenCalled();
    });
});
