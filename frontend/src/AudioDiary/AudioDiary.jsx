import React, { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
    Alert,
    Box,
    Button,
    Container,
    HStack,
    IconButton,
    Text,
    Textarea,
    VStack,
    Field,
} from "@chakra-ui/react";
import { keyframes } from "@emotion/react";
import { useAudioRecorder } from "./useAudioRecorder.js";
import { formatTime } from "./audio_helpers.js";
import AudioVisualization from "./AudioVisualization.jsx";
import { MicrophoneIcon, PauseIcon, StopIcon } from "./icons.jsx";
import RestoredSessionBanner from "./RestoredSessionBanner.jsx";
import RecorderStatusBadge from "./RecorderStatusBadge.jsx";
import LiveQuestionsPanel from "./LiveQuestionsPanel.jsx";
import { useDiaryLiveQuestioningController } from "./useDiaryLiveQuestioningController.js";
import { submitDiaryAudio } from "./diary_audio_api.js";
import { initializeLiveQuestions } from "./session_api.js";

const pulseRing = keyframes`
    0%   { box-shadow: 0 0 0 0 rgba(229, 62, 62, 0.5); }
    70%  { box-shadow: 0 0 0 16px rgba(229, 62, 62, 0); }
    100% { box-shadow: 0 0 0 0 rgba(229, 62, 62, 0); }
`;

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
        displayedQuestions,
        pinnedQuestions,
        pinnedQuestionIds,
        onQuestions: liveOnQuestions,
        togglePin,
        startLive,
        stopLive,
    } = useDiaryLiveQuestioningController();

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
        sessionIdRef,
        hasRestoredSession,
        setNote,
        setErrorMessage,
        handleStart: handleStartBase,
        handlePauseResume,
        handleStop: handleStopBase,
        handleDiscard: handleDiscardBase,
        clearPersistedSession,
    } = useAudioRecorder({ onQuestions: liveOnQuestions });

    // When a session is restored in paused state, start live questioning polling so
    // that live questions appear when the user resumes the restored recording.
    useEffect(() => {
        if (hasRestoredSession && recorderState === "paused") {
            startLive(sessionIdRef.current);
        }
    }, [hasRestoredSession, recorderState, startLive]);

    // Wrap handleStart to also start live questioning and trigger initial questions.
    const handleStart = useCallback(async () => {
        try {
            await handleStartBase();
            const sessionId = sessionIdRef.current;
            startLive(sessionId);
            // Fire-and-forget: generate initial questions from the diary summary.
            // This runs asynchronously and failures are silently ignored.
            initializeLiveQuestions(sessionId);
        } catch (error) {
            // Ensure live questioning is not left running if recorder start fails.
            stopLive();
        }
    }, [handleStartBase, sessionIdRef, startLive, stopLive]);

    // Wrap handleStop to also stop live questioning.
    const handleStop = useCallback(async () => {
        stopLive();
        await handleStopBase();
    }, [handleStopBase, stopLive]);

    // Wrap handleDiscard to also stop live questioning.
    const handleDiscard = useCallback(() => {
        stopLive();
        handleDiscardBase();
    }, [handleDiscardBase, stopLive]);

    /** @type {[boolean, React.Dispatch<React.SetStateAction<boolean>>]} */
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = useCallback(async () => {
        if (!audioBlob) {
            return;
        }

        setIsSubmitting(true);
        setErrorMessage("");

        try {
            const result = await submitDiaryAudio(
                audioBlob,
                mimeTypeRef.current || "audio/webm",
                note
            );

            if (!isMountedRef.current) {
                return;
            }

            if (result.entry && result.entry.id) {
                clearPersistedSession();
                navigate(`/entry/${result.entry.id}`);
            } else {
                clearPersistedSession();
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
    }, [audioBlob, note, navigate, clearPersistedSession]);

    const isRecording = recorderState === "recording";
    const isPaused = recorderState === "paused";
    const isStopped = recorderState === "stopped";
    const isIdle = recorderState === "idle";

    return (
        <Container maxW="sm" px={4} py={8}>
            <VStack gap={6} align="stretch">
                <Text fontSize="xl" fontWeight="bold" textAlign="center">
                    Record Diary
                </Text>

                <RestoredSessionBanner hasRestoredSession={hasRestoredSession} />

                <RecorderStatusBadge
                    isRecording={isRecording}
                    isPaused={isPaused}
                    isStopped={isStopped}
                />

                {(isRecording || isPaused) && (
                    <Box textAlign="center">
                        <Text fontSize="3xl" fontFamily="mono" data-testid="timer">
                            {formatTime(elapsedSeconds)}
                        </Text>
                    </Box>
                )}

                {(isRecording || isPaused) && (
                    <AudioVisualization analyser={analyser} isActive={isRecording} />
                )}

                <VStack gap={4}>
                    {(isIdle || isRecording || isPaused) && (
                        <HStack gap={4} justify="center" align="center">
                            {isIdle && (
                                <IconButton
                                    aria-label="Start recording"
                                    rounded="full"
                                    size="lg"
                                    w="72px"
                                    h="72px"
                                    colorScheme="red"
                                    onClick={handleStart}
                                    data-testid="start-button"><MicrophoneIcon
                                        width="32px"
                                        height="32px"
                                    /></IconButton>
                            )}

                            {(isRecording || isPaused) && (
                                <>
                                    <IconButton
                                        aria-label={isRecording ? "Pause recording" : "Resume recording"}
                                        rounded="full"
                                        size="lg"
                                        w="72px"
                                        h="72px"
                                        colorScheme={isRecording ? "yellow" : "red"}
                                        onClick={handlePauseResume}
                                        data-testid="pause-resume-button"
                                        animation={
                                            isRecording
                                                ? `${pulseRing} 1.5s ease-out infinite`
                                                : undefined
                                        }>{isRecording ? (
                                            <PauseIcon width="28px" height="28px" />
                                        ) : (
                                            <MicrophoneIcon width="28px" height="28px" />
                                        )}</IconButton>
                                    <IconButton
                                        aria-label="Stop recording"
                                        rounded="full"
                                        size="md"
                                        colorScheme="gray"
                                        onClick={handleStop}
                                        data-testid="stop-button"><StopIcon width="24px" height="24px" /></IconButton>
                                </>
                            )}
                        </HStack>
                    )}

                    {isIdle && (
                        <Text fontSize="sm" color="gray.500" textAlign="center">
                            Tap the microphone to start
                        </Text>
                    )}

                    {(isRecording || isPaused) && (
                        <Button
                            colorPalette="red"
                            variant="outline"
                            size="sm"
                            w="full"
                            onClick={handleDiscard}
                            data-testid="discard-button"
                        >
                            Discard
                        </Button>
                    )}

                    {isStopped && audioBlob && (
                        <>
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

                            <Field.Root>
                                <Text fontSize="sm">
                                    Add a note (optional)
                                </Text>
                                <Textarea
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    placeholder="e.g., morning reflection"
                                    size="sm"
                                    rows={2}
                                    data-testid="note-input"
                                />
                            </Field.Root>

                            <HStack w="full" gap={3}>
                                <Button
                                    colorPalette="red"
                                    variant="outline"
                                    flex={1}
                                    onClick={handleDiscard}
                                    data-testid="discard-button"
                                >
                                    Discard
                                </Button>
                                <Button
                                    colorPalette="green"
                                    flex={1}
                                    onClick={handleSubmit}
                                    loading={isSubmitting}
                                    loadingText="Submitting…"
                                    data-testid="submit-button"
                                >
                                    Submit
                                </Button>
                            </HStack>
                        </>
                    )}
                </VStack>

                {errorMessage && (
                    <Alert.Root status="error" borderRadius="md">
                        <Alert.Indicator />
                        <Box>
                            <Alert.Title>Error</Alert.Title>
                            <Alert.Description>{errorMessage}</Alert.Description>
                        </Box>
                    </Alert.Root>
                )}

                {(isRecording || isPaused) && (
                    <LiveQuestionsPanel
                        displayedQuestions={displayedQuestions}
                        pinnedQuestions={pinnedQuestions}
                        pinnedQuestionIds={pinnedQuestionIds}
                        onTogglePin={togglePin}
                        errorMessage={null}
                    />
                )}

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
