import React from "react";
import { Box, Text } from "@chakra-ui/react";
import { SPACING } from "../styles.js";

/**
 * Help tab component
 * @param {Object} props
 * @param {string} props.helpText - The help text to display
 */
export const HelpTab = ({ helpText }) => (
    <Box
        bg="gray.50"
        p={SPACING.md}
        borderRadius="md"
        borderLeft="4px solid"
        borderLeftColor="blue.400"
    >
        <Text fontSize="sm" whiteSpace="pre-wrap">
            {helpText}
        </Text>
    </Box>
);
