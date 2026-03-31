import React from "react";
import { VStack, HStack, Text, Spinner } from "@chakra-ui/react";

/**
 * @typedef {import('./api.js').DiarySummaryRunEntry} DiarySummaryRunEntry
 */

/** @type {{ [key: string]: string }} */
const ENTRY_BG_COLOR = {
    success: "green.50",
    error: "red.50",
    pending: "gray.50",
};

/** @type {{ [key: string]: string }} */
const ENTRY_TEXT_COLOR = {
    success: "green.700",
    error: "red.700",
    pending: "gray.500",
};

/**
 * Displays the progress of individual diary summary entries being processed.
 * @param {{ entries: DiarySummaryRunEntry[], isRunning: boolean }} props
 * @returns {React.JSX.Element | null}
 */
export function DiarySummaryEntryList({ entries, isRunning }) {
    if (entries.length === 0 && !isRunning) {
        return null;
    }

    if (entries.length === 0 && isRunning) {
        return (
            <HStack gap={2}>
                <Spinner size="xs" />
                <Text fontSize="sm" color="gray.500">Scanning diary entries…</Text>
            </HStack>
        );
    }

    return (
        <VStack gap={1} align="stretch">
            {entries.map((entry, index) => {
                const colorKey = entry.status;
                const label = entry.path.split("/").pop() ?? entry.path;

                return (
                    <HStack
                        key={`${entry.path}-${index}`}
                        gap={2}
                        px={2}
                        py={1}
                        borderRadius="md"
                        bg={ENTRY_BG_COLOR[colorKey]}
                    >
                        {entry.status === "success" && (
                            <Text fontSize="xs" color="green.500">✓</Text>
                        )}
                        {entry.status === "error" && (
                            <Text fontSize="xs" color="red.500">✗</Text>
                        )}
                        {entry.status === "pending" && (
                            <Spinner size="xs" color="gray.400" />
                        )}
                        <Text
                            fontSize="xs"
                            color={ENTRY_TEXT_COLOR[colorKey]}
                            overflow="hidden"
                            textOverflow="ellipsis"
                            whiteSpace="nowrap"
                        >
                            {label}
                        </Text>
                    </HStack>
                );
            })}
        </VStack>
    );
}
