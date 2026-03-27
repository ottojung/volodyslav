/**
 * Tests for useDiaryLiveQuestioningController.
 *
 * The controller now manages display state only.  Live diary questioning runs
 * server-side as part of push-audio; questions arrive via `onQuestions()`.
 */

import { renderHook, act } from "@testing-library/react";
import { useDiaryLiveQuestioningController } from "../src/AudioDiary/useDiaryLiveQuestioningController.js";

// ─── startLive / stopLive ─────────────────────────────────────────────────────

describe("startLive", () => {
    it("resets displayedGenerations", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => result.current.startLive());

        expect(result.current.displayedGenerations).toEqual([]);
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
            ], 1);
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
            result.current.onQuestions([], 1);
        });

        expect(result.current.displayedGenerations).toHaveLength(0);
    });

    it("uses provided chunk sequence as milestoneNumber", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        act(() => {
            result.current.onQuestions([{ text: "Q1", intent: "clarifying" }], 1);
        });
        act(() => {
            result.current.onQuestions([{ text: "Q2", intent: "clarifying" }], 3);
        });

        expect(result.current.displayedGenerations[0].milestoneNumber).toBe(3);
        expect(result.current.displayedGenerations[1].milestoneNumber).toBe(1);
    });

    it("trims displayed generations to MAX_VISIBLE_GENERATIONS (4)", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());
        act(() => result.current.startLive());

        for (let i = 0; i < 6; i++) {
            act(() => {
                result.current.onQuestions([{ text: `Q${i}`, intent: "clarifying" }], i + 1);
            });
        }

        expect(result.current.displayedGenerations.length).toBeLessThanOrEqual(4);
    });

    it("ignores questions if called before startLive", () => {
        const { result } = renderHook(() => useDiaryLiveQuestioningController());

        act(() => {
            result.current.onQuestions([{ text: "Ignored", intent: "clarifying" }], 1);
        });

        expect(result.current.displayedGenerations).toHaveLength(0);
    });
});
