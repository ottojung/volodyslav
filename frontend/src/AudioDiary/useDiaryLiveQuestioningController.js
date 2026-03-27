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
 * @property {number} milestoneNumber - Chunk sequence number that produced this generation.
 * @property {DiaryQuestion[]} questions - List of questions in this generation.
 */

/**
 * @typedef {object} UseDiaryLiveQuestioningControllerResult
 * @property {QuestionGeneration[]} displayedGenerations - Question generations, newest first.
 * @property {(questions: DiaryQuestion[], milestoneNumber: number) => void} onQuestions - Call with questions from each chunk upload and its chunk sequence number.
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

    /** @type {React.MutableRefObject<boolean>} */
    const isRunningRef = useRef(false);

    /**
     * Called with questions returned from a chunk upload.
     * Adds a new generation to the display (newest first, max 4).
     */
    const onQuestions = useCallback(
        /**
         * @param {DiaryQuestion[]} questions
         * @param {number} milestoneNumber
         */
        (questions, milestoneNumber) => {
            if (!isRunningRef.current || !questions || questions.length === 0) {
                return;
            }

            const generation = {
                generationId: makeGenerationId(milestoneNumber),
                milestoneNumber,
                questions,
            };

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
        setDisplayedGenerations([]);
    }, []);

    /**
     * Stop live questioning. New questions will be ignored.
     */
    const stopLive = useCallback(() => {
        isRunningRef.current = false;
    }, []);

    return {
        displayedGenerations,
        onQuestions,
        startLive,
        stopLive,
    };
}
