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
import { CARD_STYLES, TEXT_STYLES, BADGE_STYLES } from "./styles.js";

/**
 * @typedef {Object} Entry
 * @property {string} id - Unique identifier for the entry
 * @property {string} date - ISO date string
 * @property {string} type - Type of the entry
 * @property {string} description - Description of the entry
 */

/**
 * Individual entry component
 * @param {Object} props
 * @param {Entry} props.entry - The entry data
 * @param {number} props.index - Index for fallback key
 * @param {(id: string) => void} [props.onDelete] - Called when delete button is clicked
 * @returns {JSX.Element}
 */
export const EntryItem = ({ entry, index, onDelete }) => (
    <Box key={entry.id || index} {...CARD_STYLES.entry}>
        <HStack justify="space-between" align="flex-start">
            <VStack align="flex-start" spacing={1} flex={1}>
                <HStack spacing={2}>
                    <Badge {...BADGE_STYLES}>
                        {entry.type}
                    </Badge>
                    <Text {...TEXT_STYLES.entryMeta}>
                        {formatRelativeDate(entry.date)}
                    </Text>
                </HStack>
                <Text {...TEXT_STYLES.entryText}>
                    {entry.description}
                </Text>
            </VStack>
            {onDelete && (
                <IconButton
                    aria-label="Delete entry"
                    size="sm"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}
                    icon={<span>&times;</span>}
                />
            )}
        </HStack>
    </Box>
);

/**
 * Loading skeleton for entries
 * @returns {JSX.Element}
 */
export const EntryItemSkeleton = () => (
    <Box {...CARD_STYLES.entry}>
        <VStack align="flex-start" spacing={2}>
            <HStack spacing={2}>
                <Skeleton height="16px" width="60px" />
                <Skeleton height="14px" width="50px" />
            </HStack>
            <Skeleton height="16px" width="100%" />
        </VStack>
    </Box>
);
