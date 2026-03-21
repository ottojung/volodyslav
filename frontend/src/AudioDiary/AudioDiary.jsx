import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
    Alert,
    AlertIcon,
    AlertTitle,
    AlertDescription,
    Box,
    Button,
    Container,
    FormControl,
    FormLabel,
    HStack,
    Text,
    Textarea,
    VStack,
} from "@chakra-ui/react";
import { submitEntry } from "../DescriptionEntry/api.js";
import { makeRecorder, isRecorder } from "./recorder_logic.js";
import AudioVisualization from "./AudioVisualization.jsx";

/** @typedef {import('./recorder_logic.js').RecorderState} RecorderState */

/**
 * Format seconds as mm:ss.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Derive a file extension from a MIME type string.
 * @param {string} mimeType
 * @returns {string}
 */
function extensionForMime(mimeType) {
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("mp4")) return "mp4";
    return "webm";
}

/** @returns {RecorderState} */
function initialRecorderState() {
    return "idle";
}

/** @returns {Blob | null} */
function initialAudioBlob() {
    return null;
}

/** @returns {AnalyserNode | null} */
function initialAnalyser() {
    return null;
}

/**
 * Audio diary recording page.
 *
 * Lets the user record audio via the browser's MediaRecorder API and
 * submit it as a diary entry.
 *
 * @returns {React.JSX.Element}
 */
export default function AudioDiary() {
    const navigate = useNavigate();

    /** @type {[RecorderState, React.Dispatch<React.SetStateAction<RecorderState>>]} */
    const [recorderState, setRecorderState] = useState(initialRecorderState());

    /** @type {[Blob | null, React.Dispatch<React.SetStateAction<Blob | null>>]} */
    const [audioBlob, setAudioBlob] = useState(initialAudioBlob());

    /** @type {[string, React.Dispatch<React.SetStateAction<string>>]} */
    const [audioUrl, setAudioUrl] = useState("");

    /** @type {[string, React.Dispatch<React.SetStateAction<string>>]} */
    const [note, setNote] = useState("");

    /** @type {[number, React.Dispatch<React.SetStateAction<number>>]} */
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    /** @type {[string, React.Dispatch<React.SetStateAction<string>>]} */
    const [errorMessage, setErrorMessage] = useState("");

    /** @type {[boolean, React.Dispatch<React.SetStateAction<boolean>>]} */
    const [isSubmitting, setIsSubmitting] = useState(false);

    /** @type {[AnalyserNode | null, React.Dispatch<React.SetStateAction<AnalyserNode | null>>]} */
    const [analyser, setAnalyser] = useState(initialAnalyser());

    /** @type {React.MutableRefObject<ReturnType<typeof makeRecorder> | null>} */
    const recorderRef = useRef(null);

    /** @type {React.MutableRefObject<number | null>} */
    const timerRef = useRef(null);

    /** @type {React.MutableRefObject<string>} */
    const mimeTypeRef = useRef("");

    // Build recorder on mount, discard on unmount
    useEffect(() => {
        const recorder = makeRecorder({
            onStateChange: (state) => {
                setRecorderState(state);
            },
            onStop: (blob) => {
                mimeTypeRef.current = blob.type;
                setAudioBlob(blob);
                const url = URL.createObjectURL(blob);
                setAudioUrl(url);
            },
            onError: (message) => {
                setErrorMessage(message);
            },
            onAnalyser: (node) => {
                setAnalyser(node);
            },
        });

        recorderRef.current = recorder;

        return () => {
            if (isRecorder(recorderRef.current)) {
                recorderRef.current.discard();
            }
            recorderRef.current = null;
        };
    }, []);

    // Revoke object URL on unmount / when blob changes
    useEffect(() => {
        return () => {
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
            }
        };
    }, [audioUrl]);

    // Live timer while recording
    useEffect(() => {
        if (recorderState === "recording") {
            timerRef.current = window.setInterval(() => {
                setElapsedSeconds((s) => s + 1);
            }, 1000);
        } else {
            if (timerRef.current !== null) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }

        return () => {
            if (timerRef.current !== null) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [recorderState]);

    const handleStart = useCallback(async () => {
        setErrorMessage("");
        setElapsedSeconds(0);
        setAudioBlob(null);
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
            setAudioUrl("");
        }
        if (isRecorder(recorderRef.current)) {
            await recorderRef.current.start();
        }
    }, [audioUrl]);

    const handlePauseResume = useCallback(() => {
        if (!isRecorder(recorderRef.current)) {
            return;
        }
        if (recorderState === "recording") {
            recorderRef.current.pause();
        } else if (recorderState === "paused") {
            recorderRef.current.resume();
        }
    }, [recorderState]);

    const handleStop = useCallback(() => {
        if (isRecorder(recorderRef.current)) {
            recorderRef.current.stop();
        }
    }, []);

    const handleDiscard = useCallback(() => {
        if (isRecorder(recorderRef.current)) {
            recorderRef.current.discard();
        }
        setAudioBlob(null);
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
            setAudioUrl("");
        }
        setElapsedSeconds(0);
        setNote("");
        setErrorMessage("");
        setAnalyser(null);
    }, [audioUrl]);

    const handleSubmit = useCallback(async () => {
        if (!audioBlob) {
            return;
        }

        setIsSubmitting(true);
        setErrorMessage("");

        try {
            const ext = extensionForMime(mimeTypeRef.current);
            const filename = `diary-recording.${ext}`;
            const file = new File([audioBlob], filename, {
                type: mimeTypeRef.current || "audio/webm",
            });

            const rawInput = note.trim()
                ? `diary [audiorecording] ${note.trim()}`
                : "diary [audiorecording]";

            const result = await submitEntry(rawInput, undefined, [file]);

            if (result.entry && result.entry.id) {
                navigate(`/entry/${result.entry.id}`);
            } else {
                navigate("/search");
            }
        } catch (err) {
            const message =
                err instanceof Error ? err.message : String(err);
            setErrorMessage(`Submission failed: ${message}`);
        } finally {
            setIsSubmitting(false);
        }
    }, [audioBlob, note, navigate]);

    const isRecording = recorderState === "recording";
    const isPaused = recorderState === "paused";
    const isStopped = recorderState === "stopped";
    const isIdle = recorderState === "idle";

    return (
        <Container maxW="sm" px={4} py={8}>
            <VStack spacing={6} align="stretch">
                <Text fontSize="xl" fontWeight="bold" textAlign="center">
                    Record Diary
                </Text>

                {/* Recorder state badge */}
                <Box textAlign="center">
                    <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        color={
                            isRecording
                                ? "red.500"
                                : isPaused
                                ? "yellow.600"
                                : isStopped
                                ? "green.600"
                                : "gray.500"
                        }
                        textTransform="uppercase"
                        letterSpacing="wide"
                    >
                        {isRecording
                            ? "● Recording"
                            : isPaused
                            ? "⏸ Paused"
                            : isStopped
                            ? "■ Stopped"
                            : "Idle"}
                    </Text>
                </Box>

                {/* Live timer */}
                {(isRecording || isPaused) && (
                    <Box textAlign="center">
                        <Text fontSize="3xl" fontFamily="mono" data-testid="timer">
                            {formatTime(elapsedSeconds)}
                        </Text>
                    </Box>
                )}

                {/* Audio level meter */}
                {(isRecording || isPaused) && (
                    <AudioVisualization analyser={analyser} isActive={isRecording} />
                )}

                {/* Controls */}
                <VStack spacing={3}>
                    {isIdle && (
                        <Button
                            colorScheme="red"
                            w="full"
                            onClick={handleStart}
                            data-testid="start-button"
                        >
                            Start Recording
                        </Button>
                    )}

                    {(isRecording || isPaused) && (
                        <>
                            <HStack w="full" spacing={3}>
                                <Button
                                    colorScheme="yellow"
                                    flex={1}
                                    onClick={handlePauseResume}
                                    data-testid="pause-resume-button"
                                >
                                    {isRecording ? "Pause" : "Resume"}
                                </Button>
                                <Button
                                    colorScheme="gray"
                                    flex={1}
                                    onClick={handleStop}
                                    data-testid="stop-button"
                                >
                                    Stop
                                </Button>
                            </HStack>
                            <Button
                                colorScheme="red"
                                variant="outline"
                                w="full"
                                onClick={handleDiscard}
                                data-testid="discard-button"
                            >
                                Discard
                            </Button>
                        </>
                    )}

                    {isStopped && audioBlob && (
                        <>
                            {/* Playback */}
                            <Box w="full">
                                <Text fontSize="sm" mb={1} color="gray.600">
                                    Preview
                                </Text>
                                <audio
                                    controls
                                    src={audioUrl}
                                    style={{ width: "100%" }}
                                    data-testid="audio-preview"
                                />
                            </Box>

                            {/* Optional note */}
                            <FormControl>
                                <FormLabel fontSize="sm">
                                    Add a note (optional)
                                </FormLabel>
                                <Textarea
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    placeholder="e.g., morning reflection"
                                    size="sm"
                                    rows={2}
                                    data-testid="note-input"
                                />
                            </FormControl>

                            <HStack w="full" spacing={3}>
                                <Button
                                    colorScheme="red"
                                    variant="outline"
                                    flex={1}
                                    onClick={handleDiscard}
                                    data-testid="discard-button"
                                >
                                    Discard
                                </Button>
                                <Button
                                    colorScheme="green"
                                    flex={1}
                                    onClick={handleSubmit}
                                    isLoading={isSubmitting}
                                    loadingText="Submitting…"
                                    data-testid="submit-button"
                                >
                                    Submit
                                </Button>
                            </HStack>
                        </>
                    )}
                </VStack>

                {/* Error display */}
                {errorMessage && (
                    <Alert status="error" borderRadius="md">
                        <AlertIcon />
                        <Box>
                            <AlertTitle>Error</AlertTitle>
                            <AlertDescription>{errorMessage}</AlertDescription>
                        </Box>
                    </Alert>
                )}

                {/* Back link */}
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate("/")}
                    data-testid="back-button"
                >
                    ← Back
                </Button>
            </VStack>
        </Container>
    );
}
