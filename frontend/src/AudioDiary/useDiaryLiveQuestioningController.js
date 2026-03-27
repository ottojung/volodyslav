/**
 * Controller hook for live diary questioning.
 *
 * Manages:
 *  - Milestone scheduling (every audio fragment from the recorder)
 *  - In-flight push-audio requests
 *  - Question generation feed
 *
 * All transcription, recombination, and question generation are handled
 * server-side.  The client only sends raw 10-second audio blobs and receives
 * diary questions in response.
 *
 * @module useDiaryLiveQuestioningController
 */

import { useState, useRef, useCallback } from "react";
import { pushAudio } from "./diary_live_api.js";

/** @typedef {import('./diary_live_api.js').DiaryQuestion} DiaryQuestion */

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
 * @property {(data: Blob, startMs: number, endMs: number) => void} onFragment - Call with each audio fragment.
 * @property {(sessionId: string, mimeType: string) => void} startLive - Start live questioning.
 * @property {() => void} stopLive - Stop live questioning and cancel pending work.
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

/** @returns {QuestionGeneration[]} */
function initialDisplayedGenerations() {
    return [];
}

/** @returns {string | null} */
function initialLiveErrorMessage() {
    return null;
}

/** @returns {UseDiaryLiveQuestioningControllerResult} */
export function useDiaryLiveQuestioningController() {
    const [displayedGenerations, setDisplayedGenerations] = useState(
        initialDisplayedGenerations()
    );

    const [liveErrorMessage, setLiveErrorMessage] = useState(
        initialLiveErrorMessage()
    );

    /** @type {React.MutableRefObject<string>} */
    const sessionIdRef = useRef("");

    /** @type {React.MutableRefObject<string>} */
    const mimeTypeRef = useRef("");

    /** @type {React.MutableRefObject<boolean>} */
    const isRunningRef = useRef(false);

    /** @type {React.MutableRefObject<number>} */
    const milestoneRef = useRef(0);

    /**
     * Called for each new 10-second audio fragment from the recorder.
     * Sends the raw audio blob to the server and displays any returned questions.
     */
    const onFragment = useCallback(
        /**
         * @param {Blob} data
         * @param {number} _startMs
         * @param {number} _endMs
         */
        async (data, _startMs, _endMs) => {
            if (!isRunningRef.current) {
                return;
            }

            if (data.type) {
                mimeTypeRef.current = data.type;
            }

            milestoneRef.current += 1;
            const milestoneNumber = milestoneRef.current;
            const mimeType = mimeTypeRef.current || "audio/webm";

            let result;
            try {
                result = await pushAudio({
                    audioBlob: data,
                    mimeType,
                    sessionId: sessionIdRef.current,
                    fragmentNumber: milestoneNumber,
                });
            } catch {
                setLiveErrorMessage("Live prompts are catching up\u2026");
                return;
            }

            if (!isRunningRef.current) {
                return;
            }

            setLiveErrorMessage(null);

            if (result.questions.length === 0) {
                return;
            }

            const generation = {
                generationId: makeGenerationId(milestoneNumber),
                milestoneNumber,
                questions: result.questions,
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
     * @param {string} sessionId
     * @param {string} mimeType
     */
    const startLive = useCallback(
        /**
         * @param {string} sessionId
         * @param {string} mimeType
         */
        (sessionId, mimeType) => {
            sessionIdRef.current = sessionId;
            mimeTypeRef.current = mimeType;
            isRunningRef.current = true;
            milestoneRef.current = 0;
            setDisplayedGenerations([]);
            setLiveErrorMessage(null);
        },
        []
    );

    /**
     * Stop live questioning. Cancels processing of future milestones.
     * In-flight requests will complete but their results will be ignored.
     */
    const stopLive = useCallback(() => {
        isRunningRef.current = false;
    }, []);

    return {
        displayedGenerations,
        liveErrorMessage,
        onFragment,
        startLive,
        stopLive,
    };
}
