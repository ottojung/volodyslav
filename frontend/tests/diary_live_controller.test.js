/**
 * Tests for useDiaryLiveQuestioningController.
 *
 * The controller now manages a flat list of individual questions with
 * pinning support. Questions arrive via `onQuestions()`.
 */

import { renderHook, act } from "@testing-library/react";
import { useDiaryLiveQuestioningController } from "../src/AudioDiary/useDiaryLiveQuestioningController.js";
import * as sessionApi from "../src/AudioDiary/session_api.js";

jest.mock("../src/AudioDiary/session_api.js", () => ({
    getLiveQuestions: jest.fn(),
}));

// ─── startLive / stopLive ─────────────────────────────────────────────────────

describe("startLive", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        sessionApi.getLiveQuestions.mockReset();
    });

    afterEach(() => {
        act(() => {
            jest.runOnlyPendingTimers();
        });
        jest.useRealTimers();
    });

    it("resets displayedQuestions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive("session-start"));

        expect(result.current.displayedQuestions).toEqual([]);
    });

    it("ignores stale poll responses from a previous session after stop/start", async () => {
        /** @type {(value: Array<{text: string, intent: "warm_reflective" | "clarifying" | "forward"}>) => void} */
        let resolveFirstPoll;
        const firstPollPromise = new Promise((resolve) => {
            resolveFirstPoll = resolve;
        });
        sessionApi.getLiveQuestions
            .mockImplementationOnce(() => firstPollPromise)
            .mockResolvedValueOnce([{ text: "Fresh session question", intent: "clarifying" }]);

        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive("session-old"));
        await act(async () => {
            jest.advanceTimersByTime(5000);
        });
        expect(sessionApi.getLiveQuestions).toHaveBeenCalledWith("session-old");

        act(() => result.current.stopLive());
        act(() => result.current.startLive("session-new"));

        await act(async () => {
            resolveFirstPoll([{ text: "Stale old question", intent: "clarifying" }]);
            await firstPollPromise;
        });
        expect(result.current.displayedQuestions).toHaveLength(0);

        await act(async () => {
            jest.advanceTimersByTime(5000);
        });
        expect(sessionApi.getLiveQuestions).toHaveBeenCalledWith("session-new");
        expect(result.current.displayedQuestions).toHaveLength(1);
        expect(result.current.displayedQuestions[0].text).toBe("Fresh session question");
    });
});

describe("stopLive", () => {
    it("ignores questions sent after stopLive is called", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive("session-stop"));
        act(() => result.current.stopLive());

        act(() => {
            result.current.onQuestions([
                { text: "Should be ignored", intent: "clarifying" },
            ], 1);
        });

        expect(result.current.displayedQuestions).toHaveLength(0);
    });
});

// ─── onQuestions ──────────────────────────────────────────────────────────────

describe("onQuestions", () => {
    it("adds individual questions (not grouped) when called with questions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-onquestions-1"));

        act(() => {
            result.current.onQuestions([
                { text: "How did that make you feel?", intent: "warm_reflective" },
                { text: "What happened next?", intent: "clarifying" },
            ], 1);
        });

        // Two individual questions in the flat list.
        expect(result.current.displayedQuestions).toHaveLength(2);
        expect(result.current.displayedQuestions[0].text).toBe("How did that make you feel?");
        expect(result.current.displayedQuestions[1].text).toBe("What happened next?");
    });

    it("each question gets a unique questionId", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-onquestions-2"));

        act(() => {
            result.current.onQuestions([
                { text: "Q1", intent: "clarifying" },
                { text: "Q2", intent: "clarifying" },
            ], 1);
        });

        const ids = result.current.displayedQuestions.map((q) => q.questionId);
        expect(new Set(ids).size).toBe(2);
    });

    it("does not add questions when called with empty array", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-onquestions-3"));

        act(() => {
            result.current.onQuestions([], 1);
        });

        expect(result.current.displayedQuestions).toHaveLength(0);
    });

    it("adds newer questions at the front (newest first)", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-onquestions-4"));

        act(() => {
            result.current.onQuestions([{ text: "Q1", intent: "clarifying" }], 1);
        });
        act(() => {
            result.current.onQuestions([{ text: "Q2", intent: "clarifying" }], 2);
        });

        expect(result.current.displayedQuestions[0].text).toBe("Q2");
        expect(result.current.displayedQuestions[1].text).toBe("Q1");
    });

    it("trims displayedQuestions to MAX_VISIBLE_UNPINNED (8)", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-onquestions-5"));

        for (let i = 0; i < 10; i++) {
            act(() => {
                result.current.onQuestions([{ text: `Q${i}`, intent: "clarifying" }], i + 1);
            });
        }

        expect(result.current.displayedQuestions.length).toBeLessThanOrEqual(8);
    });

    it("ignores questions if called before startLive", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => {
            result.current.onQuestions([{ text: "Ignored", intent: "clarifying" }], 1);
        });

        expect(result.current.displayedQuestions).toHaveLength(0);
    });
});

// ─── togglePin ────────────────────────────────────────────────────────────────

describe("togglePin", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        act(() => {
            jest.runOnlyPendingTimers();
        });
        jest.useRealTimers();
    });

    it("pins a question: moves it from displayedQuestions to pinnedQuestions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-pin-1"));

        act(() => {
            result.current.onQuestions([{ text: "Pin me", intent: "warm_reflective" }], 1);
        });

        const questionId = result.current.displayedQuestions[0].questionId;

        act(() => {
            result.current.togglePin(questionId);
        });

        expect(result.current.pinnedQuestions).toHaveLength(1);
        expect(result.current.pinnedQuestions[0].text).toBe("Pin me");
        expect(result.current.pinnedQuestions[0].isNew).toBe(false);
        expect(result.current.displayedQuestions).toHaveLength(0);
        expect(result.current.pinnedQuestionIds).toContain(questionId);
    });

    it("unpins a question: removes it from pinnedQuestions and displayedQuestions entirely", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-pin-2"));

        act(() => {
            result.current.onQuestions([{ text: "Toggle me", intent: "clarifying" }], 1);
        });

        const questionId = result.current.displayedQuestions[0].questionId;

        // Pin it.
        act(() => {
            result.current.togglePin(questionId);
        });
        expect(result.current.pinnedQuestions).toHaveLength(1);

        // Unpin it.
        act(() => {
            result.current.togglePin(questionId);
        });

        expect(result.current.pinnedQuestions).toHaveLength(0);
        expect(result.current.displayedQuestions).toHaveLength(0);
        expect(result.current.pinnedQuestionIds).toHaveLength(0);
    });

    it("startLive resets all pinned questions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive("session-pin-3"));

        act(() => {
            result.current.onQuestions([{ text: "Pinned Q", intent: "clarifying" }], 1);
        });

        const questionId = result.current.displayedQuestions[0].questionId;
        act(() => {
            result.current.togglePin(questionId);
        });
        expect(result.current.pinnedQuestions).toHaveLength(1);

        // Start a new session — should reset everything.
        act(() => {
            result.current.startLive("new-session");
        });

        expect(result.current.pinnedQuestions).toHaveLength(0);
        expect(result.current.pinnedQuestionIds).toHaveLength(0);
        expect(result.current.displayedQuestions).toHaveLength(0);
    });
});
