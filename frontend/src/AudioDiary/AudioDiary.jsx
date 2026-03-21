import React, { useState, useCallback } from "react";
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
import { useAudioRecorder } from "./useAudioRecorder.js";
import { formatTime, extensionForMime } from "./audio_helpers.js";
import AudioVisualization from "./AudioVisualization.jsx";

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

    const {
        recorderState,
        audioBlob,
        audioUrl,
        note,
        elapsedSeconds,
        errorMessage,
        analyser,
        mimeTypeRef,
        isMountedRef,
        setNote,
        setErrorMessage,
        handleStart,
        handlePauseResume,
        handleStop,
        handleDiscard,
    } = useAudioRecorder();

    /** @type {[boolean, React.Dispatch<React.SetStateAction<boolean>>]} */
    const [isSubmitting, setIsSubmitting] = useState(false);

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

            if (!isMountedRef.current) {
                return;
            }

            if (result.entry && result.entry.id) {
                navigate(`/entry/${result.entry.id}`);
            } else {
                navigate("/search");
            }
        } catch (err) {
            if (!isMountedRef.current) {
                return;
            }
            const message =
                err instanceof Error ? err.message : String(err);
            setErrorMessage(`Submission failed: ${message}`);
        } finally {
            if (isMountedRef.current) {
                setIsSubmitting(false);
            }
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
