/**
 * Controller hook for live diary questioning display state.
 *
 * Manages the display of live diary questions that arrive from the backend
 * as a side-effect of push-audio calls.  All transcription, recombination,
 * and question generation are handled server-side; this hook only owns the
 * client-side presentation state.
 *
 * Questions are retrieved by polling GET /audio-recording-session/:sessionId/live-questions
 * every POLLING_INTERVAL_MS milliseconds while recording is active.
 *
 * Each question is shown as an independent item.  Clicking a question pins
 * it to the top of the list; clicking again removes the pin (and the question
 * disappears from the display).
 *
 * @module useDiaryLiveQuestioningController
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { getLiveQuestions } from "./session_api.js";

/** @typedef {import('./session_api.js').DiaryQuestion} DiaryQuestion */

/**
 * How often (in ms) to poll the backend for newly generated diary questions.
 */
const POLLING_INTERVAL_MS = 5000;
const NEW_FLAG_DURATION_MS = 300;

/**
 * Maximum number of unpinned questions to keep visible at once.
 */
const MAX_VISIBLE_UNPINNED = 8;

/**
 * @typedef {object} DisplayedQuestion
 * @property {string} questionId - Unique identifier for this displayed question.
 * @property {string} text - Question text.
 * @property {"warm_reflective" | "clarifying" | "forward"} intent - Question intent.
 * @property {boolean} isNew - Whether this question just arrived (for animation).
 */

/**
 * @typedef {object} UseDiaryLiveQuestioningControllerResult
 * @property {DisplayedQuestion[]} displayedQuestions - Non-pinned questions, newest first.
 * @property {string[]} pinnedQuestionIds - IDs of pinned questions, in pinning order.
 * @property {DisplayedQuestion[]} pinnedQuestions - Pinned questions, in pinning order.
 * @property {(questions: DiaryQuestion[], milestoneNumber: number) => void} onQuestions - Call with questions from each push-audio response and its fragment sequence number.
 * @property {(questionId: string) => void} togglePin - Toggle the pinned state of a question. Pinned questions are promoted to the top; un-pinning removes the question entirely.
 * @property {(sessionId: string) => void} startLive - Reset display state and begin polling for a new recording session.
 * @property {() => void} stopLive - Stop accepting new questions and stop polling.
 */

/**
 * Monotonically increasing counter for unique question IDs.
 * Module-level so it persists across hook instances within the same page load.
 */
let _questionCounter = 0;

/**
 * Generate a simple unique ID for a displayed question.
 * @returns {string}
 */
function makeQuestionId() {
    _questionCounter += 1;
    return `q-${_questionCounter}`;
}

/** @returns {UseDiaryLiveQuestioningControllerResult} */
export function useDiaryLiveQuestioningController() {
    /** @type {[DisplayedQuestion[], import('react').Dispatch<import('react').SetStateAction<DisplayedQuestion[]>>]} */
    const [displayedQuestions, setDisplayedQuestions] = useState(
        /** @returns {DisplayedQuestion[]} */ () => []
    );

    /**
     * Mirror of displayedQuestions kept in a ref so callbacks can read the
     * current list without closing over stale state.
     * @type {import('react').MutableRefObject<DisplayedQuestion[]>}
     */
    const displayedQuestionsRef = useRef([]);

    /** @type {[string[], import('react').Dispatch<import('react').SetStateAction<string[]>>]} */
    const [pinnedQuestionIds, setPinnedQuestionIds] = useState(
        /** @returns {string[]} */ () => []
    );
    /** @type {import('react').MutableRefObject<string[]>} */
    const pinnedQuestionIdsRef = useRef([]);

    /** @type {[DisplayedQuestion[], import('react').Dispatch<import('react').SetStateAction<DisplayedQuestion[]>>]} */
    const [pinnedQuestions, setPinnedQuestions] = useState(
        /** @returns {DisplayedQuestion[]} */ () => []
    );
    /** @type {import('react').MutableRefObject<DisplayedQuestion[]>} */
    const pinnedQuestionsRef = useRef([]);

    /** @type {import('react').MutableRefObject<boolean>} */
    const isRunningRef = useRef(false);
    /** @type {import('react').MutableRefObject<string>} */
    const currentSessionIdRef = useRef("");
    /** @type {import('react').MutableRefObject<ReturnType<typeof setInterval> | null>} */
    const pollingIntervalRef = useRef(null);
    /** @type {import('react').MutableRefObject<number>} */
    const pollingCounterRef = useRef(0);
    /** @type {import('react').MutableRefObject<boolean>} */
    const isPollInFlightRef = useRef(false);
    /**
     * IDs of pending isNew-clear timeouts.  Tracked so they can be cancelled
     * when the session stops or the component unmounts, preventing stale
     * setState calls after the recording ends.
     * @type {import('react').MutableRefObject<ReturnType<typeof setTimeout>[]>}
     */
    const newFlagTimeoutsRef = useRef([]);

    // Keep displayedQuestionsRef in sync with state so callbacks always have
    // the current list without closing over a stale value.
    useEffect(() => {
        displayedQuestionsRef.current = displayedQuestions;
    }, [displayedQuestions]);
    useEffect(() => {
        pinnedQuestionIdsRef.current = pinnedQuestionIds;
    }, [pinnedQuestionIds]);
    useEffect(() => {
        pinnedQuestionsRef.current = pinnedQuestions;
    }, [pinnedQuestions]);

    /**
     * Cancel and clear all pending isNew-clear timeouts.
     */
    const clearNewFlagTimeouts = useCallback(() => {
        for (const id of newFlagTimeoutsRef.current) {
            clearTimeout(id);
        }
        newFlagTimeoutsRef.current = [];
    }, []);

    /**
     * Called with questions returned from push-audio or from polling.
     * Adds each individual question to the flat display list (newest first).
     */
    const onQuestions = useCallback(
        /**
         * @param {DiaryQuestion[]} questions
         * @param {number} _milestoneNumber
         */
        (questions, _milestoneNumber) => {
            if (!isRunningRef.current || !questions || questions.length === 0) {
                return;
            }

            /** @type {DisplayedQuestion[]} */
            const newItems = questions.map((q) => ({
                questionId: makeQuestionId(),
                text: q.text,
                intent: q.intent,
                isNew: true,
            }));

            const updatedQuestions = [
                ...newItems,
                ...displayedQuestionsRef.current,
            ].slice(0, MAX_VISIBLE_UNPINNED);
            displayedQuestionsRef.current = updatedQuestions;
            setDisplayedQuestions(updatedQuestions);

            const timeoutId = setTimeout(() => {
                const newItemIds = new Set(newItems.map((ni) => ni.questionId));
                const updatedQuestions = displayedQuestionsRef.current.map((q) =>
                    newItemIds.has(q.questionId)
                        ? { ...q, isNew: false }
                        : q
                );
                displayedQuestionsRef.current = updatedQuestions;
                setDisplayedQuestions(updatedQuestions);
                newFlagTimeoutsRef.current = newFlagTimeoutsRef.current.filter((id) => id !== timeoutId);
            }, NEW_FLAG_DURATION_MS);
            newFlagTimeoutsRef.current.push(timeoutId);
        },
        []
    );

    /**
     * Toggle pin state for a question.
     * - If not pinned: move to pinnedQuestions at the front, remove from unpinned.
     * - If already pinned: remove from pinnedQuestions entirely.
     * @param {string} questionId
     */
    const togglePin = useCallback(
        (/** @type {string} */ questionId) => {
            const currentlyPinnedIds = pinnedQuestionIdsRef.current;
            const currentlyPinnedQuestions = pinnedQuestionsRef.current;
            const currentlyDisplayed = displayedQuestionsRef.current;
            const alreadyPinned = currentlyPinnedIds.includes(questionId);

            if (alreadyPinned) {
                const newPinnedIds = currentlyPinnedIds.filter((id) => id !== questionId);
                const newPinnedQuestions = currentlyPinnedQuestions.filter((q) => q.questionId !== questionId);
                const newDisplayedQuestions = currentlyDisplayed.filter((q) => q.questionId !== questionId);

                pinnedQuestionIdsRef.current = newPinnedIds;
                pinnedQuestionsRef.current = newPinnedQuestions;
                displayedQuestionsRef.current = newDisplayedQuestions;

                setPinnedQuestionIds(newPinnedIds);
                setPinnedQuestions(newPinnedQuestions);
                setDisplayedQuestions(newDisplayedQuestions);
                return;
            }

            const question = currentlyDisplayed.find((q) => q.questionId === questionId);
            if (!question) {
                return;
            }

            const pinnedQuestion = { ...question, isNew: false };
            const newPinnedIds = [questionId, ...currentlyPinnedIds];
            const newPinnedQuestions = [pinnedQuestion, ...currentlyPinnedQuestions];
            const newDisplayedQuestions = currentlyDisplayed.filter((q) => q.questionId !== questionId);

            pinnedQuestionIdsRef.current = newPinnedIds;
            pinnedQuestionsRef.current = newPinnedQuestions;
            displayedQuestionsRef.current = newDisplayedQuestions;

            setPinnedQuestionIds(newPinnedIds);
            setPinnedQuestions(newPinnedQuestions);
            setDisplayedQuestions(newDisplayedQuestions);
        },
        []
    );

    /**
     * Start live questioning for a new recording session.
     * Resets display state and begins polling for questions.
     * @param {string} sessionId
     */
    const startLive = useCallback(
        /** @param {string} sessionId */
        (sessionId) => {
            clearNewFlagTimeouts();
            isRunningRef.current = true;
            currentSessionIdRef.current = sessionId;
            displayedQuestionsRef.current = [];
            pinnedQuestionIdsRef.current = [];
            pinnedQuestionsRef.current = [];
            setDisplayedQuestions([]);
            setPinnedQuestionIds([]);
            setPinnedQuestions([]);

            // Start polling for questions generated by background AI processing.
            if (pollingIntervalRef.current !== null) {
                clearInterval(pollingIntervalRef.current);
            }
            pollingIntervalRef.current = setInterval(async () => {
                if (!isRunningRef.current || !currentSessionIdRef.current) {
                    return;
                }
                const pollSessionId = currentSessionIdRef.current;
                // Skip if a previous poll is still in flight to prevent overlapping executions.
                if (isPollInFlightRef.current) {
                    return;
                }
                isPollInFlightRef.current = true;
                try {
                    const questions = await getLiveQuestions(pollSessionId);
                    if (
                        questions.length > 0 &&
                        isRunningRef.current &&
                        currentSessionIdRef.current === pollSessionId
                    ) {
                        pollingCounterRef.current += 1;
                        onQuestions(questions, pollingCounterRef.current);
                    }
                } catch {
                    // Polling failure is best-effort; recording continues unaffected.
                } finally {
                    isPollInFlightRef.current = false;
                }
            }, POLLING_INTERVAL_MS);
        },
        [clearNewFlagTimeouts, onQuestions]
    );

    /**
     * Stop live questioning. New questions will be ignored and polling stops.
     */
    const stopLive = useCallback(() => {
        isRunningRef.current = false;
        currentSessionIdRef.current = "";
        if (pollingIntervalRef.current !== null) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
        }
        clearNewFlagTimeouts();
    }, [clearNewFlagTimeouts]);

    // Cleanup on unmount: stop polling and cancel any pending isNew timeouts.
    useEffect(() => {
        return () => {
            if (pollingIntervalRef.current !== null) {
                clearInterval(pollingIntervalRef.current);
            }
            clearNewFlagTimeouts();
        };
    }, [clearNewFlagTimeouts]);

    return {
        displayedQuestions,
        pinnedQuestionIds,
        pinnedQuestions,
        onQuestions,
        togglePin,
        startLive,
        stopLive,
    };
}
