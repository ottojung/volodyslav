import React from "react";
import {
    VStack,
    Text,
    Card,
    CardBody,
    Divider,
} from "@chakra-ui/react";
import { EntryItem, EntryItemSkeleton } from "./EntryItem.jsx";
import { CARD_STYLES, TEXT_STYLES, SPACING } from "./styles.js";

/**
 * @typedef {Object} Entry
 * @property {string} id - Unique identifier for the entry
 * @property {string} date - ISO date string
 * @property {string} type - Type of the entry
 * @property {string} description - Description of the entry
 */

/**
 * Recent entries section component
 * @param {Object} props
 * @param {Entry[]} props.entries - Array of recent entries
 * @param {boolean} props.isLoading - Whether entries are loading
 */
export const RecentEntriesSection = ({ entries, isLoading }) => {
    if (isLoading) {
        return (
            <Card {...CARD_STYLES.secondary}>
                <CardBody p={4}>
                    <VStack spacing={SPACING.md} align="stretch">
                        <Text {...TEXT_STYLES.sectionTitle}>
                            Recent Events
                        </Text>
                        <Divider />
                        {[...Array(3)].map((_, i) => (
                            <EntryItemSkeleton key={i} />
                        ))}
                    </VStack>
                </CardBody>
            </Card>
        );
    }

    if (!entries.length) {
        return null;
    }

    return (
        <Card {...CARD_STYLES.secondary}>
            <CardBody p={4}>
                <VStack spacing={SPACING.md} align="stretch">
                    <Text {...TEXT_STYLES.sectionTitle}>
                        Recent Events
                    </Text>
                    <Divider />
                    {entries.map((entry, index) => (
                        <EntryItem 
                            key={entry.id || index} 
                            entry={entry} 
                            index={index} 
                        />
                    ))}
                </VStack>
            </CardBody>
        </Card>
    );
};
