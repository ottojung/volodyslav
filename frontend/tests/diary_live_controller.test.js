/**
 * Tests for useDiaryLiveQuestioningController.
 *
 * The controller now manages a flat list of individual questions with
 * pinning support. Questions arrive via `onQuestions()`.
 */

import { renderHook, act } from "@testing-library/react";
import { useDiaryLiveQuestioningController } from "../src/AudioDiary/useDiaryLiveQuestioningController.js";

// ─── startLive / stopLive ─────────────────────────────────────────────────────

describe("startLive", () => {
    it("resets displayedQuestions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive());

        expect(result.current.displayedQuestions).toEqual([]);
    });
});

describe("stopLive", () => {
    it("ignores questions sent after stopLive is called", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive());
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
        act(() => result.current.startLive());

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
        act(() => result.current.startLive());

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
        act(() => result.current.startLive());

        act(() => {
            result.current.onQuestions([], 1);
        });

        expect(result.current.displayedQuestions).toHaveLength(0);
    });

    it("adds newer questions at the front (newest first)", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

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
        act(() => result.current.startLive());

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
    it("pins a question: moves it from displayedQuestions to pinnedQuestions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        act(() => {
            result.current.onQuestions([{ text: "Pin me", intent: "warm_reflective" }], 1);
        });

        const questionId = result.current.displayedQuestions[0].questionId;

        act(() => {
            result.current.togglePin(questionId);
        });

        expect(result.current.pinnedQuestions).toHaveLength(1);
        expect(result.current.pinnedQuestions[0].text).toBe("Pin me");
        expect(result.current.displayedQuestions).toHaveLength(0);
        expect(result.current.pinnedQuestionIds).toContain(questionId);
    });

    it("unpins a question: removes it from pinnedQuestions and displayedQuestions entirely", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

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
        act(() => result.current.startLive());

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
