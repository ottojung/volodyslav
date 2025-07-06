import React from "react";
import { VStack, Text, Box } from "@chakra-ui/react";
import { EntryItem, EntryItemSkeleton } from "../EntryItem.jsx";
import { SPACING } from "../styles.js";

/**
 * Recent entries tab component
 * @param {Object} props
 * @param {Array<any>} props.recentEntries - Array of recent entries
 * @param {boolean} props.isLoadingEntries - Whether entries are loading
 * @param {(value: string) => void} props.onShortcutClick - Called when an entry is clicked
 * @param {(id: string) => void} props.onDeleteEntry - Called when delete button is clicked
 * @returns {JSX.Element}
 */
export const RecentEntriesTab = ({ recentEntries, isLoadingEntries, onShortcutClick, onDeleteEntry }) => {
    if (isLoadingEntries) {
        return (
            <VStack spacing={SPACING.md} align="stretch">
                <Text fontSize="sm" color="gray.600">Loading recent entries...</Text>
                {[...Array(3)].map((_, i) => <EntryItemSkeleton key={i} />)}
            </VStack>
        );
    }

    if (recentEntries.length === 0) {
        return (
            <Text fontSize="sm" color="gray.500" textAlign="center" py={4}>
                No recent entries found
            </Text>
        );
    }

    return (
        <VStack spacing={SPACING.md} align="stretch">
            <Text fontSize="sm" color="gray.600">Click an entry to use it as a template:</Text>
            {recentEntries.map((entry, index) => (
                <Box
                    key={entry.id || index}
                    cursor="pointer"
                    onClick={() => onShortcutClick(entry.original || entry.input || "")}
                    _hover={{ bg: "gray.50" }}
                    p={2}
                    borderRadius="md"
                >
                    <EntryItem entry={entry} index={index} onDelete={() => onDeleteEntry(entry.id)} />
                </Box>
            ))}
        </VStack>
    );
};
