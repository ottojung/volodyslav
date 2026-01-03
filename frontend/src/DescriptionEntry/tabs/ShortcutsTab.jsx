import React from "react";
import { VStack, HStack, Text, Code, Card, CardBody, Box } from "@chakra-ui/react";
import { SPACING } from "../styles.js";

/** @typedef {import('../api.js').Shortcut} Shortcut */

/**
 * Applies a shortcut transformation to text
 * @param {string} text - The text to transform
 * @param {Shortcut} shortcut - The shortcut array [pattern, replacement]
 * @returns {string} - The transformed text
 */
const applyShortcut = (text, shortcut) => {
    try {
        const regex = new RegExp(shortcut[0], "g");
        return text.replace(regex, shortcut[1]);
    } catch (error) {
        console.warn("Invalid regex pattern:", shortcut[0]);
        return text;
    }
};

/**
 * Gets preview of shortcut transformation
 * @param {Shortcut} shortcut - The shortcut array
 * @param {string} currentInput - Current input text
 * @returns {string|null} - Preview text or null
 */
const getShortcutPreview = (shortcut, currentInput) => {
    if (!currentInput.trim()) return null;

    try {
        const regex = new RegExp(shortcut[0]);
        if (regex.test(currentInput)) {
            const transformed = applyShortcut(currentInput, shortcut);
            if (transformed !== currentInput) {
                return transformed;
            }
        }
    } catch (error) {
        // Invalid regex, ignore
    }
    return null;
};

/**
 * Shortcuts tab component
 * @param {Object} props
 * @param {Shortcut[]} props.shortcuts - Array of shortcuts
 * @param {(value: string) => void} props.onShortcutClick - Called when a shortcut is clicked
 * @param {string} props.currentInput - Current input text for preview
 * @returns {JSX.Element}
 */
export const ShortcutsTab = ({ shortcuts, onShortcutClick, currentInput }) => (
    <VStack spacing={SPACING.md} align="stretch">
        <Text fontSize="sm" color="gray.600">
            Click a shortcut to use its pattern:
        </Text>
        {shortcuts.map((shortcut, index) => {
            const preview = getShortcutPreview(shortcut, currentInput);
            return (
                <Card key={index} variant="outline" size="sm">
                    <CardBody p={SPACING.md}>
                        <VStack spacing={SPACING.sm} align="stretch">
                            <HStack
                                justify="space-between"
                                cursor="pointer"
                                onClick={() => onShortcutClick(shortcut[1])}
                                _hover={{ bg: "gray.50" }}
                                p={2}
                                borderRadius="md"
                            >
                                <HStack spacing={SPACING.sm}>
                                    <Code colorScheme="blue" fontSize="xs">
                                        {shortcut[0]}
                                    </Code>
                                    <Text color="gray.500">→</Text>
                                    <Code colorScheme="green" fontSize="xs">
                                        {shortcut[1]}
                                    </Code>
                                </HStack>
                            </HStack>
                            {shortcut[2] && (
                                <Text fontSize="xs" color="gray.600">
                                    {shortcut[2]}
                                </Text>
                            )}
                            {preview && (
                                <Box
                                    bg="blue.50"
                                    p={2}
                                    borderRadius="md"
                                    borderLeft="3px solid"
                                    borderLeftColor="blue.300"
                                >
                                    <Text
                                        fontSize="xs"
                                        color="blue.700"
                                        fontWeight="medium"
                                    >
                                        Preview: &ldquo;{currentInput}&rdquo; →
                                        &ldquo;{preview}&rdquo;
                                    </Text>
                                </Box>
                            )}
                        </VStack>
                    </CardBody>
                </Card>
            );
        })}
    </VStack>
);
