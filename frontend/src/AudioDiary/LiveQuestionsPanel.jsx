/**
 * Live prompts panel for the diary recording page.
 *
 * Displays individual live diary questions as independent items.
 * Clicking a question pins it to the top of the list (and highlights it).
 * Clicking a pinned question removes it from the display entirely.
 *
 * @module LiveQuestionsPanel
 */

import React from "react";
import { Box, Button, Text, VStack } from "@chakra-ui/react";
import { keyframes } from "@emotion/react";

/** @typedef {import('./useDiaryLiveQuestioningController.js').DisplayedQuestion} DisplayedQuestion */

const fadeIn = keyframes`
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
`;

/**
 * Renders a single question item.
 * @param {{
 *   question: DisplayedQuestion,
 *   isPinned: boolean,
 *   isNew: boolean,
 *   onTogglePin: (id: string) => void,
 * }} props
 * @returns {React.JSX.Element}
 */
function QuestionItem({ question, isPinned, isNew, onTogglePin }) {
    return (
        <Button
            type="button"
            borderRadius="md"
            p={3}
            mb={2}
            bg={isPinned ? "blue.50" : "gray.50"}
            borderLeft={isPinned ? "3px solid" : "none"}
            borderColor={isPinned ? "blue.400" : undefined}
            cursor="pointer"
            height="auto"
            minHeight="unset"
            justifyContent="flex-start"
            fontWeight="normal"
            _hover={{ bg: isPinned ? "blue.100" : "gray.100" }}
            onClick={() => onTogglePin(question.questionId)}
            aria-pressed={isPinned}
            aria-label={isPinned ? `Unpin question: ${question.text}` : `Pin question: ${question.text}`}
            textAlign="left"
            width="100%"
            whiteSpace="normal"
            style={
                isNew
                    ? { animation: `${fadeIn} 300ms ease-out` }
                    : undefined
            }
            data-testid={`question-item-${question.questionId}`}
            title={isPinned ? "Click to unpin (removes from display)" : "Click to pin to top"}
        >
            <Text
                fontSize="sm"
                lineHeight="1.5"
                color="gray.700"
                whiteSpace="normal"
                wordBreak="break-word"
                overflowWrap="anywhere"
                style={{ maxWidth: "70ch" }}
            >
                {question.text}
            </Text>
        </Button>
    );
}

/**
 * The live prompts panel shown during recording.
 *
 * @param {{
 *   displayedQuestions: DisplayedQuestion[],
 *   pinnedQuestions: DisplayedQuestion[],
 *   pinnedQuestionIds: string[],
 *   onTogglePin: (id: string) => void,
 *   errorMessage: string | null,
 * }} props
 * @returns {React.JSX.Element | null}
 */
export default function LiveQuestionsPanel({
    displayedQuestions,
    pinnedQuestions,
    pinnedQuestionIds,
    onTogglePin,
    errorMessage,
}) {
    const hasContent =
        displayedQuestions.length > 0 ||
        pinnedQuestions.length > 0 ||
        errorMessage;

    if (!hasContent) {
        return null;
    }

    const pinnedIdSet = new Set(pinnedQuestionIds);

    return (
        <Box
            mt={6}
            borderTop="1px solid"
            borderColor="gray.200"
            pt={4}
            data-testid="live-questions-panel"
        >
            <Text fontSize="xs" fontWeight="semibold" color="gray.500" mb={3} letterSpacing="wide">
                LIVE PROMPTS
            </Text>

            {errorMessage && (
                <Text fontSize="xs" color="orange.500" mb={2} data-testid="live-questions-error">
                    {errorMessage}
                </Text>
            )}

            <VStack gap={0} align="stretch">
                {pinnedQuestions.map((q) => (
                    <QuestionItem
                        key={q.questionId}
                        question={q}
                        isPinned={true}
                        isNew={q.isNew}
                        onTogglePin={onTogglePin}
                    />
                ))}
                {displayedQuestions
                    .filter((q) => !pinnedIdSet.has(q.questionId))
                    .map((q) => (
                        <QuestionItem
                            key={q.questionId}
                            question={q}
                            isPinned={false}
                            isNew={q.isNew}
                            onTogglePin={onTogglePin}
                        />
                    ))}
            </VStack>
        </Box>
    );
}
