/**
 * Controller hook for live diary questioning display state.
 *
 * Manages the display of live diary questions that arrive from the backend
 * as a side-effect of audio chunk uploads.  All transcription, recombination,
 * and question generation are handled server-side; this hook only owns the
 * client-side presentation state.
 *
 * @module useDiaryLiveQuestioningController
 */

import { useState, useRef, useCallback } from "react";

/** @typedef {import('./session_api.js').DiaryQuestion} DiaryQuestion */

/**
 * @typedef {object} QuestionGeneration
 * @property {string} generationId - Unique identifier for this generation.
 * @property {number} milestoneNumber - Milestone that triggered this generation.
 * @property {DiaryQuestion[]} questions - List of questions in this generation.
 */

/**
 * @typedef {object} UseDiaryLiveQuestioningControllerResult
 * @property {QuestionGeneration[]} displayedGenerations - Question generations, newest first.
 * @property {string | null} liveErrorMessage - Error message from live processing.
 * @property {(questions: DiaryQuestion[]) => void} onQuestions - Call with questions from each chunk upload.
 * @property {() => void} startLive - Reset display state for a new recording session.
 * @property {() => void} stopLive - Stop accepting new questions.
 */

const MAX_VISIBLE_GENERATIONS = 4;

/**
 * Monotonically increasing counter for unique generation IDs.
 * Module-level so it persists across hook instances within the same page load.
 */
let _generationCounter = 0;

/**
 * Generate a simple unique ID for a generation.
 * @param {number} milestoneNumber
 * @returns {string}
 */
function makeGenerationId(milestoneNumber) {
    _generationCounter += 1;
    return `gen-${milestoneNumber}-${_generationCounter}`;
}

/** @returns {UseDiaryLiveQuestioningControllerResult} */
export function useDiaryLiveQuestioningController() {
    const [displayedGenerations, setDisplayedGenerations] = useState(
        /** @returns {QuestionGeneration[]} */ () => []
    );

    const [liveErrorMessage, setLiveErrorMessage] = useState(
        /** @returns {string | null} */ () => null
    );

    /** @type {React.MutableRefObject<boolean>} */
    const isRunningRef = useRef(false);

    /** @type {React.MutableRefObject<number>} */
    const milestoneRef = useRef(0);

    /**
     * Called with questions returned from a chunk upload.
     * Adds a new generation to the display (newest first, max 4).
     */
    const onQuestions = useCallback(
        /** @param {DiaryQuestion[]} questions */
        (questions) => {
            if (!isRunningRef.current || !questions || questions.length === 0) {
                return;
            }

            milestoneRef.current += 1;
            const milestoneNumber = milestoneRef.current;

            const generation = {
                generationId: makeGenerationId(milestoneNumber),
                milestoneNumber,
                questions,
            };

            setLiveErrorMessage(null);
            setDisplayedGenerations((prev) => {
                const updated = [generation, ...prev];
                return updated.slice(0, MAX_VISIBLE_GENERATIONS);
            });
        },
        []
    );

    /**
     * Start live questioning for a new recording session.
     * Resets display state.
     */
    const startLive = useCallback(() => {
        isRunningRef.current = true;
        milestoneRef.current = 0;
        setDisplayedGenerations([]);
        setLiveErrorMessage(null);
    }, []);

    /**
     * Stop live questioning. New questions will be ignored.
     */
    const stopLive = useCallback(() => {
        isRunningRef.current = false;
    }, []);

    return {
        displayedGenerations,
        liveErrorMessage,
        onQuestions,
        startLive,
        stopLive,
    };
}
