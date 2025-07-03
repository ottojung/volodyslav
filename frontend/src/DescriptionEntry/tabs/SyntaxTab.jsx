import React from "react";
import { VStack, HStack, Text, Code } from "@chakra-ui/react";
import { TEXT_STYLES, SPACING } from "../styles.js";

const syntaxExamples = [
    "food [certainty 9] earl gray tea, unsweetened",
    "food [when now] [certainty 9] pizza capricciossa, medium size",
    "food[when 5 hours ago][certainty 7]caesar salad with croutons",
    "food earl gray tea, unsweetened",
];

/**
 * Syntax examples tab component
 * @param {Object} props
 * @param {(value: string) => void} props.onShortcutClick - Called when an example is clicked
 * @returns {JSX.Element}
 */
export const SyntaxTab = ({ onShortcutClick }) => (
    <VStack spacing={SPACING.md} align="stretch">
        <Text {...TEXT_STYLES.helper} fontWeight="medium">
            Syntax: TYPE [MODIFIERS...] DESCRIPTION
        </Text>
        <Text fontSize="sm" color="gray.600">
            Examples:
        </Text>
        <VStack spacing={SPACING.sm} align="stretch">
            {syntaxExamples.map((example, index) => (
                <HStack key={index} spacing={SPACING.sm}>
                    <Code
                        fontSize="sm"
                        px={3}
                        py={2}
                        flex={1}
                        cursor="pointer"
                        _hover={{ bg: "gray.100" }}
                        onClick={() => onShortcutClick(example)}
                    >
                        {example}
                    </Code>
                </HStack>
            ))}
        </VStack>
    </VStack>
);
