/**
 * Controller hook for live diary questioning.
 *
 * Manages:
 *  - An audio ring buffer (last 120s of raw fragments)
 *  - Milestone scheduling (every 10s of recording)
 *  - In-flight transcription and question-generation requests
 *  - Merged transcript state
 *  - Question generation feed
 *
 * @module useDiaryLiveQuestioningController
 */

import { useState, useRef, useCallback } from "react";
import { transcribeWindow, generateQuestions } from "./diary_live_api.js";

/** @typedef {import('./diary_live_api.js').DiaryQuestion} DiaryQuestion */
/** @typedef {import('./diary_live_api.js').TranscriptToken} TranscriptToken */

/**
 * @typedef {object} AudioFragment
 * @property {number} startMs - Fragment start time (ms from recording start).
 * @property {number} endMs - Fragment end time (ms from recording start).
 * @property {Blob} data - Raw audio blob.
 */

/**
 * @typedef {object} QuestionGeneration
 * @property {string} generationId - Unique identifier for this generation.
 * @property {number} milestoneNumber - Milestone that triggered this generation.
 * @property {DiaryQuestion[]} questions - List of questions in this generation.
 */

/**
 * @typedef {object} DiaryLiveState
 * @property {QuestionGeneration[]} displayedGenerations - Newest generation first.
 * @property {string} mergedTranscript - Full merged transcript text.
 * @property {string | null} errorMessage - Current error message (if any).
 */

/**
 * @typedef {object} UseDiaryLiveQuestioningControllerResult
 * @property {QuestionGeneration[]} displayedGenerations - Question generations, newest first.
 * @property {string} mergedTranscript - Current merged transcript text.
 * @property {string | null} liveErrorMessage - Error message from live processing.
 * @property {(data: Blob, startMs: number, endMs: number) => void} onFragment - Call with each audio fragment.
 * @property {(sessionId: string, mimeType: string) => void} startLive - Start live questioning.
 * @property {() => void} stopLive - Stop live questioning and cancel pending work.
 */

const MAX_RING_BUFFER_MS = 120_000;
const WINDOW_DURATION_MS = 20_000;
const MAX_VISIBLE_GENERATIONS = 4;
const MIN_NEW_CHARS_FOR_GENERATION = 30;

/**
 * Merge a new transcription window into the existing canonical token list.
 *
 * Replace-zone policy: remove all existing tokens overlapping with the new
 * window, then insert the new tokens.  This allows the ASR model to revise
 * earlier words that appear in the overlap region.
 *
 * @param {TranscriptToken[]} existing - Current canonical tokens sorted by startMs.
 * @param {TranscriptToken[]} incoming - New tokens from the latest window.
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @returns {TranscriptToken[]} Updated token list sorted by startMs.
 */
export function mergeTranscriptionWindow(existing, incoming, windowStartMs, windowEndMs) {
    // Remove tokens that overlap the replace zone.
    const kept = existing.filter(
        (t) => !(t.endMs > windowStartMs && t.startMs < windowEndMs)
    );

    // Insert new tokens and sort by start time.
    const merged = [...kept, ...incoming].sort((a, b) => a.startMs - b.startMs);

    return merged;
}

/**
 * Build the full text from a token list with normalised spacing.
 * @param {TranscriptToken[]} tokens
 * @returns {string}
 */
export function tokensToText(tokens) {
    return tokens.map((t) => t.text.trim()).filter(Boolean).join(" ");
}

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

/**
 * Deduplicate questions by normalised text, keeping the first occurrence.
 * @param {DiaryQuestion[]} questions
 * @param {string[]} askedTexts - Texts already asked in previous generations.
 * @returns {DiaryQuestion[]}
 */
function deduplicateQuestions(questions, askedTexts) {
    const normalise = (/** @type {string} */ s) =>
        s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

    const seen = new Set(askedTexts.map(normalise));
    /** @type {DiaryQuestion[]} */
    const result = [];
    for (const q of questions) {
        const key = normalise(q.text);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(q);
        }
    }
    return result;
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

    const [mergedTranscript, setMergedTranscript] = useState("");

    const [liveErrorMessage, setLiveErrorMessage] = useState(
        initialLiveErrorMessage()
    );

    // Mutable refs for values we need in callbacks without triggering re-renders.
    /** @type {React.MutableRefObject<AudioFragment[]>} */
    const ringBufferRef = useRef([]);

    /** @type {React.MutableRefObject<string>} */
    const sessionIdRef = useRef("");

    /** @type {React.MutableRefObject<string>} */
    const mimeTypeRef = useRef("");

    /** @type {React.MutableRefObject<boolean>} */
    const isRunningRef = useRef(false);

    /** @type {React.MutableRefObject<number>} */
    const milestoneRef = useRef(0);

    /** @type {React.MutableRefObject<TranscriptToken[]>} */
    const canonicalTokensRef = useRef([]);

    /** @type {React.MutableRefObject<string>} */
    const lastGeneratedTranscriptRef = useRef("");

    /** @type {React.MutableRefObject<string[]>} */
    const askedQuestionsRef = useRef([]);

    /** @type {React.MutableRefObject<Set<number>>} */
    const inFlightTranscriptionRef = useRef(new Set());

    /** @type {React.MutableRefObject<Set<number>>} */
    const inFlightQuestionsRef = useRef(new Set());

    /**
     * Process one milestone: slice audio window, transcribe, then generate questions.
     * @param {number} milestoneNumber
     * @param {number} windowStartMs
     * @param {number} windowEndMs
     * @returns {Promise<void>}
     */
    const processMilestone = useCallback(
        /**
         * @param {number} milestoneNumber
         * @param {number} windowStartMs
         * @param {number} windowEndMs
         */
        async (milestoneNumber, windowStartMs, windowEndMs) => {
            if (!isRunningRef.current) {
                return;
            }

            // Don't start a second in-flight transcription for the same milestone.
            if (inFlightTranscriptionRef.current.has(milestoneNumber)) {
                return;
            }

            // Slice ring buffer for this window.
            const fragments = ringBufferRef.current.filter(
                (f) => f.endMs > windowStartMs && f.startMs < windowEndMs
            );

            if (fragments.length === 0) {
                return;
            }

            const mimeType = mimeTypeRef.current || "audio/webm";
            const audioBlob = new Blob(
                fragments.map((f) => f.data),
                { type: mimeType }
            );

            inFlightTranscriptionRef.current.add(milestoneNumber);

            let windowResult;
            try {
                windowResult = await transcribeWindow({
                    audioBlob,
                    mimeType,
                    sessionId: sessionIdRef.current,
                    milestoneNumber,
                    windowStartMs,
                    windowEndMs,
                });
            } catch (err) {
                setLiveErrorMessage("Live prompts are catching up…");
                return;
            } finally {
                inFlightTranscriptionRef.current.delete(milestoneNumber);
            }

            if (!isRunningRef.current) {
                return;
            }

            // Merge the new window into canonical tokens.
            const updatedTokens = mergeTranscriptionWindow(
                canonicalTokensRef.current,
                windowResult.tokens,
                windowResult.windowStartMs,
                windowResult.windowEndMs
            );
            canonicalTokensRef.current = updatedTokens;
            const fullText = tokensToText(updatedTokens);
            setMergedTranscript(fullText);
            setLiveErrorMessage(null);

            // Check if there's enough new content to generate questions.
            const prevText = lastGeneratedTranscriptRef.current;
            const newChars = fullText.replace(/\s/g, "").length - prevText.replace(/\s/g, "").length;
            if (newChars < MIN_NEW_CHARS_FOR_GENERATION && prevText.length > 0) {
                return;
            }

            // Don't start a second in-flight question generation for the same milestone.
            if (inFlightQuestionsRef.current.has(milestoneNumber)) {
                return;
            }

            inFlightQuestionsRef.current.add(milestoneNumber);

            let questionsResult;
            try {
                questionsResult = await generateQuestions({
                    sessionId: sessionIdRef.current,
                    milestoneNumber,
                    transcriptSoFar: fullText,
                    askedQuestions: askedQuestionsRef.current,
                });
            } catch (err) {
                // Keep previous questions visible on failure.
                return;
            } finally {
                inFlightQuestionsRef.current.delete(milestoneNumber);
            }

            if (!isRunningRef.current) {
                return;
            }

            // Deduplicate questions against previously asked ones.
            const dedupedQuestions = deduplicateQuestions(
                questionsResult.questions,
                askedQuestionsRef.current
            );

            if (dedupedQuestions.length === 0) {
                return;
            }

            // Record all asked questions to prevent repetition in future generations.
            askedQuestionsRef.current = [
                ...askedQuestionsRef.current,
                ...dedupedQuestions.map((q) => q.text),
            ];

            lastGeneratedTranscriptRef.current = fullText;

            const generation = {
                generationId: makeGenerationId(milestoneNumber),
                milestoneNumber,
                questions: dedupedQuestions,
            };

            setDisplayedGenerations((prev) => {
                const updated = [generation, ...prev];
                // Trim to maximum visible count.
                return updated.slice(0, MAX_VISIBLE_GENERATIONS);
            });
        },
        []
    );

    /**
     * Called for each new audio fragment from the recorder.
     * Adds to the ring buffer, evicts old data, and triggers the next milestone.
     */
    const onFragment = useCallback(
        /**
         * @param {Blob} data
         * @param {number} startMs
         * @param {number} endMs
         */
        (data, startMs, endMs) => {
            if (!isRunningRef.current) {
                return;
            }

            // Update MIME type from the fragment blob if available.
            if (data.type) {
                mimeTypeRef.current = data.type;
            }

            // Add to ring buffer and evict fragments beyond MAX_RING_BUFFER_MS.
            ringBufferRef.current = [
                ...ringBufferRef.current.filter((f) => f.endMs > endMs - MAX_RING_BUFFER_MS),
                { data, startMs, endMs },
            ];

            // Increment milestone counter and compute window.
            milestoneRef.current += 1;
            const milestoneNumber = milestoneRef.current;
            const windowEndMs = endMs;
            const windowStartMs = Math.max(0, windowEndMs - WINDOW_DURATION_MS);

            // Fire-and-forget: process this milestone asynchronously.
            processMilestone(milestoneNumber, windowStartMs, windowEndMs).catch(() => {
                // Errors are handled inside processMilestone.
            });
        },
        [processMilestone]
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
            ringBufferRef.current = [];
            canonicalTokensRef.current = [];
            lastGeneratedTranscriptRef.current = "";
            askedQuestionsRef.current = [];
            inFlightTranscriptionRef.current = new Set();
            inFlightQuestionsRef.current = new Set();
            setDisplayedGenerations([]);
            setMergedTranscript("");
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
        mergedTranscript,
        liveErrorMessage,
        onFragment,
        startLive,
        stopLive,
    };
}
