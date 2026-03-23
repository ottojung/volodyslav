import React from "react";
import {
    Box,
    VStack,
    HStack,
    Text,
    Badge,
    Skeleton,
    IconButton,
} from "@chakra-ui/react";
import { formatRelativeDate } from "./utils.js";
import { CARD_STYLES, TEXT_STYLES } from "./styles.js";
import { getEntryType, getEntryDescription } from "./entry.js";

/**
 * @typedef {Object} Entry
 * @property {string} id - Unique identifier for the entry
 * @property {string} date - ISO date string
 * @property {string} input - Processed input
 */

/**
 * Individual entry component
 * @param {Object} props
 * @param {Entry} props.entry - The entry data
 * @param {number} props.index - Index for fallback key
 * @param {(id: string) => void} [props.onDelete] - Called when delete button is clicked
 * @returns {React.JSX.Element}
 */
export const EntryItem = ({ entry, index, onDelete }) => (
    <Box key={entry.id || index} {...CARD_STYLES.entry}>
        <HStack justify="space-between" align="flex-start">
            <VStack align="flex-start" gap={1} flex={1}>
                <HStack gap={2}>
                    <Badge colorPalette="blue" variant="subtle">
                        {getEntryType(entry)}
                    </Badge>
                    <Text {...TEXT_STYLES.entryMeta}>
                        {formatRelativeDate(entry.date)}
                    </Text>
                </HStack>
                <Text {...TEXT_STYLES.entryText}>
                    {getEntryDescription(entry)}
                </Text>
            </VStack>
            {onDelete && (
                <IconButton
                    aria-label="Delete entry"
                    size="sm"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}><span>&times;</span></IconButton>
            )}
        </HStack>
    </Box>
);

/**
 * Loading skeleton for entries
 * @returns {React.JSX.Element}
 */
export const EntryItemSkeleton = () => (
    <Box {...CARD_STYLES.entry}>
        <VStack align="flex-start" gap={2}>
            <HStack gap={2}>
                <Skeleton height="16px" width="60px" />
                <Skeleton height="14px" width="50px" />
            </HStack>
            <Skeleton height="16px" width="100%" />
        </VStack>
    </Box>
);
