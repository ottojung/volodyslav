/**
 * Live prompts panel for the diary recording page.
 *
 * Displays the most recent question generations in a stacked list,
 * newest generation at the top.  Older generations shift downward with
 * a gentle spring animation when a new generation arrives.
 *
 * @module LiveQuestionsPanel
 */

import React, { useRef, useEffect, useState } from "react";
import { Box, Text, VStack, List } from "@chakra-ui/react";
import { keyframes } from "@emotion/react";

/** @typedef {import('./useDiaryLiveQuestioningController.js').QuestionGeneration} QuestionGeneration */

const fadeIn = keyframes`
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
`;

/**
 * Opacity for each generation slot, indexed from newest (0) to oldest.
 * @type {number[]}
 */
const GENERATION_OPACITIES = [1.0, 0.88, 0.72, 0.56];

/**
 * Renders a single generation card.
 * @param {{
 *   generation: QuestionGeneration,
 *   index: number,
 *   isNew: boolean,
 * }} props
 * @returns {React.JSX.Element}
 */
function GenerationCard({ generation, index, isNew }) {
    const opacity = GENERATION_OPACITIES[index] ?? 0.5;

    return (
        <Box
            borderRadius="md"
            p={3}
            mb={2}
            bg={index === 0 ? "blue.50" : "gray.50"}
            opacity={opacity}
            style={
                isNew
                    ? {
                          animation: `${fadeIn} 300ms ease-out`,
                      }
                    : undefined
            }
            data-testid={`question-generation-${generation.generationId}`}
        >
            <List.Root gap={1} ps={4}>
                {generation.questions.map((q, qi) => (
                    <List.Item
                        key={`${generation.generationId}-${qi}`}
                        fontSize="sm"
                        lineHeight="1.5"
                        color="gray.700"
                        style={{ maxWidth: "70ch" }}
                    >
                        {q.text}
                    </List.Item>
                ))}
            </List.Root>
        </Box>
    );
}

/**
 * The live prompts panel shown during recording.
 *
 * @param {{
 *   displayedGenerations: QuestionGeneration[],
 *   errorMessage: string | null,
 * }} props
 * @returns {React.JSX.Element | null}
 */
export default function LiveQuestionsPanel({ displayedGenerations, errorMessage }) {
    const hasContent = displayedGenerations.length > 0 || errorMessage;

    // Track which generation ID was last committed to the DOM via useEffect,
    // so the "isNew" fade-in flag is derived from committed state (not render).
    /** @type {React.MutableRefObject<string | null>} */
    const latestGenerationIdRef = useRef(null);
    const [isNewGeneration, setIsNewGeneration] = useState(false);

    const newestId = displayedGenerations[0]?.generationId ?? null;

    useEffect(() => {
        if (newestId !== null && newestId !== latestGenerationIdRef.current) {
            latestGenerationIdRef.current = newestId;
            setIsNewGeneration(true);
            // Clear the "new" flag after the animation completes (300 ms).
            const timer = setTimeout(() => setIsNewGeneration(false), 300);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [newestId]);

    if (!hasContent) {
        return null;
    }

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
                {displayedGenerations.map((gen, idx) => (
                    <GenerationCard
                        key={gen.generationId}
                        generation={gen}
                        index={idx}
                        isNew={idx === 0 && isNewGeneration}
                    />
                ))}
            </VStack>
        </Box>
    );
}
