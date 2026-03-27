/**
 * Tests for useDiaryLiveQuestioningController.
 *
 * The controller now manages display state only.  Live diary questioning runs
 * server-side as part of chunk upload; questions arrive via `onQuestions()`.
 */

import { renderHook, act } from "@testing-library/react";
import { useDiaryLiveQuestioningController } from "../src/AudioDiary/useDiaryLiveQuestioningController.js";

// ─── startLive / stopLive ─────────────────────────────────────────────────────

describe("startLive", () => {
    it("resets displayedGenerations and liveErrorMessage", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive());

        expect(result.current.displayedGenerations).toEqual([]);
        expect(result.current.liveErrorMessage).toBeNull();
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
            ]);
        });

        expect(result.current.displayedGenerations).toHaveLength(0);
    });
});

// ─── onQuestions ──────────────────────────────────────────────────────────────

describe("onQuestions", () => {
    it("adds a QuestionGeneration when called with questions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        act(() => {
            result.current.onQuestions([
                { text: "How did that make you feel?", intent: "warm_reflective" },
            ]);
        });

        expect(result.current.displayedGenerations).toHaveLength(1);
        expect(result.current.displayedGenerations[0].questions[0].text).toBe(
            "How did that make you feel?"
        );
    });

    it("does not add a generation when called with empty questions", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        act(() => {
            result.current.onQuestions([]);
        });

        expect(result.current.displayedGenerations).toHaveLength(0);
    });

    it("increments milestoneNumber across calls", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        act(() => {
            result.current.onQuestions([{ text: "Q1", intent: "clarifying" }]);
        });
        act(() => {
            result.current.onQuestions([{ text: "Q2", intent: "clarifying" }]);
        });

        expect(result.current.displayedGenerations[0].milestoneNumber).toBe(2);
        expect(result.current.displayedGenerations[1].milestoneNumber).toBe(1);
    });

    it("trims displayed generations to MAX_VISIBLE_GENERATIONS (4)", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        for (let i = 0; i < 6; i++) {
            act(() => {
                result.current.onQuestions([{ text: `Q${i}`, intent: "clarifying" }]);
            });
        }

        expect(result.current.displayedGenerations.length).toBeLessThanOrEqual(4);
    });

    it("ignores questions if called before startLive", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => {
            result.current.onQuestions([{ text: "Ignored", intent: "clarifying" }]);
        });

        expect(result.current.displayedGenerations).toHaveLength(0);
    });

    it("clears liveErrorMessage when questions are received", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        act(() => {
            result.current.onQuestions([{ text: "Q1", intent: "clarifying" }]);
        });

        expect(result.current.liveErrorMessage).toBeNull();
    });
});

