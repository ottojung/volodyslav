import React, { useState } from "react";
import { Box, VStack, HStack, Text, IconButton, Button } from "@chakra-ui/react";
import {
    CARD_STYLES,
    TEXT_STYLES,
} from "../DescriptionEntry/styles.js";
import { getEntryParsed } from "../DescriptionEntry/entry.js";

/**
 * @typedef {import('../DescriptionEntry/entry.js').Entry} Entry
 */

const COLLAPSED_FIELD_VALUE_LENGTH = 100;

/**
 * Converts an entry field value into a display string.
 * @param {string|object} value
 * @returns {string}
 */
export function stringifyFieldValue(value) {
    if (typeof value === "string") {
        return value;
    }

    return JSON.stringify(value);
}

/**
 * Splits an entry into summary and derived key-value pairs for display.
 * @param {Entry} entry
 * @returns {{primaryFields: Array<{key: string, value: string}>, derivedFields: Array<{key: string, value: string}>}}
 */
export function entryToFields(entry) {
    const primaryFields = [
        { key: "original", value: entry.original },
        { key: "date", value: entry.date },
        { key: "id", value: entry.id },
    ];

    const { type: entryType, description: entryDescription, modifiers: entryModifiers } = getEntryParsed(entry);
    const derivedFields = [
        { key: "type", value: entryType },
        { key: "description", value: entryDescription },
        { key: "input", value: entry.input },
    ];

    for (const [k, v] of Object.entries(entry.creator)) {
        derivedFields.push({ key: `creator.${k}`, value: stringifyFieldValue(v) });
    }

    for (const [k, v] of Object.entries(entryModifiers)) {
        derivedFields.push({ key: `modifiers.${k}`, value: v });
    }

    return { primaryFields, derivedFields };
}

/**
 * A single field row with a copy button.
 * @param {{ fieldKey: string, value: string }} props
 * @returns {React.JSX.Element}
 */
export function FieldRow({ fieldKey, value }) {
    const [copied, setCopied] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const isCollapsible = value.length > COLLAPSED_FIELD_VALUE_LENGTH;
    const displayedValue = !isCollapsible || isExpanded
        ? value
        : `${value.slice(0, COLLAPSED_FIELD_VALUE_LENGTH)}…`;

    async function handleCopy() {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <Box {...CARD_STYLES.entry}>
            <VStack align="flex-start" gap={1} minW={0}>
                <HStack justify="space-between" align="flex-start" w="full">
                    <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase">
                        {fieldKey}
                    </Text>
                    <IconButton
                        aria-label={`Copy ${fieldKey}`}
                        size="sm"
                        variant="ghost"
                        onClick={handleCopy}
                        flexShrink={0}
                        title={copied ? "Copied!" : "Copy"}
                    >
                        <span>{copied ? "✓" : "⎘"}</span>
                    </IconButton>
                </HStack>
                <Text {...TEXT_STYLES.entryText} wordBreak="normal">{displayedValue}</Text>
                {isCollapsible && (
                    <Button
                        size="xs"
                        variant='plain'
                        colorPalette="blue"
                        onClick={() => setIsExpanded((currentValue) => !currentValue)}
                        aria-label={`${isExpanded ? "Show less" : "Show full"} ${fieldKey}`}
                    >
                        {isExpanded ? "Show less" : "Show more"}
                    </Button>
                )}
            </VStack>
        </Box>
    );
}
