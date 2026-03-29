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
    /** @type {[DisplayedQuestion[], React.Dispatch<React.SetStateAction<DisplayedQuestion[]>>]} */
    const [displayedQuestions, setDisplayedQuestions] = useState(
        /** @returns {DisplayedQuestion[]} */ () => []
    );

    /**
     * Map from questionId to DisplayedQuestion for O(1) lookup when pinning.
     * Kept in sync with displayedQuestions state.
     * @type {React.MutableRefObject<Map<string, DisplayedQuestion>>}
     */
    const questionMapRef = useRef(/** @type {Map<string, DisplayedQuestion>} */ (new Map()));

    /** @type {[string[], React.Dispatch<React.SetStateAction<string[]>>]} */
    const [pinnedQuestionIds, setPinnedQuestionIds] = useState(
        /** @returns {string[]} */ () => []
    );

    /** @type {[DisplayedQuestion[], React.Dispatch<React.SetStateAction<DisplayedQuestion[]>>]} */
    const [pinnedQuestions, setPinnedQuestions] = useState(
        /** @returns {DisplayedQuestion[]} */ () => []
    );

    /** @type {React.MutableRefObject<boolean>} */
    const isRunningRef = useRef(false);
    /** @type {React.MutableRefObject<string>} */
    const currentSessionIdRef = useRef("");
    /** @type {React.MutableRefObject<ReturnType<typeof setInterval> | null>} */
    const pollingIntervalRef = useRef(null);
    /** @type {React.MutableRefObject<number>} */
    const pollingCounterRef = useRef(0);
    /** @type {React.MutableRefObject<boolean>} */
    const isPollInFlightRef = useRef(false);

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

            for (const item of newItems) {
                questionMapRef.current.set(item.questionId, item);
            }

            setDisplayedQuestions((prev) => {
                const updated = [...newItems, ...prev];
                return updated.slice(0, MAX_VISIBLE_UNPINNED);
            });

            // Clear isNew flag after animation (300 ms).
            setTimeout(() => {
                setDisplayedQuestions((prev) =>
                    prev.map((q) =>
                        newItems.some((ni) => ni.questionId === q.questionId)
                            ? { ...q, isNew: false }
                            : q
                    )
                );
            }, 300);
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
        (questionId) => {
            setPinnedQuestionIds((prevPinned) => {
                const alreadyPinned = prevPinned.includes(questionId);
                if (alreadyPinned) {
                    // Unpin: remove from pinned list.
                    const newPinned = prevPinned.filter((id) => id !== questionId);
                    setPinnedQuestions((prevPinnedQ) =>
                        prevPinnedQ.filter((q) => q.questionId !== questionId)
                    );
                    // Also remove from unpinned list if present (question disappears).
                    setDisplayedQuestions((prevUnpinned) =>
                        prevUnpinned.filter((q) => q.questionId !== questionId)
                    );
                    return newPinned;
                } else {
                    // Pin: move from unpinned to pinned.
                    const question = questionMapRef.current.get(questionId);
                    if (!question) {
                        return prevPinned;
                    }
                    setPinnedQuestions((prevPinnedQ) => [question, ...prevPinnedQ]);
                    setDisplayedQuestions((prevUnpinned) =>
                        prevUnpinned.filter((q) => q.questionId !== questionId)
                    );
                    return [questionId, ...prevPinned];
                }
            });
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
            isRunningRef.current = true;
            currentSessionIdRef.current = sessionId;
            questionMapRef.current.clear();
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
                // Skip if a previous poll is still in flight to prevent overlapping executions.
                if (isPollInFlightRef.current) {
                    return;
                }
                isPollInFlightRef.current = true;
                try {
                    const questions = await getLiveQuestions(currentSessionIdRef.current);
                    if (questions.length > 0 && isRunningRef.current) {
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
        [onQuestions]
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
    }, []);

    // Cleanup polling interval on unmount.
    useEffect(() => {
        return () => {
            if (pollingIntervalRef.current !== null) {
                clearInterval(pollingIntervalRef.current);
            }
        };
    }, []);

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
