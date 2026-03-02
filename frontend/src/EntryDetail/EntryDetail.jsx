import React, { useState, useEffect } from "react";
import { useParams, useLocation } from "react-router-dom";
import {
    Container,
    VStack,
    Card,
    CardBody,
    HStack,
    Text,
    IconButton,
    Tooltip,
    Spinner,
    Box,
    Badge,
} from "@chakra-ui/react";
import { fetchEntryById } from "../Search/api.js";
import {
    SPACING,
    SIZES,
    CARD_STYLES,
    TEXT_STYLES,
    BADGE_STYLES,
} from "../DescriptionEntry/styles.js";

/**
 * @typedef {import('../DescriptionEntry/entry.js').Entry} Entry
 */

/**
 * Flattens an entry into a list of key-value pairs for display.
 * @param {Entry} entry
 * @returns {Array<{key: string, value: string}>}
 */
function entryToFields(entry) {
    const fields = [
        { key: "id", value: entry.id },
        { key: "date", value: entry.date },
        { key: "type", value: entry.type },
        { key: "description", value: entry.description },
        { key: "input", value: entry.input },
        { key: "original", value: entry.original },
    ];

    for (const [k, v] of Object.entries(entry.modifiers)) {
        fields.push({ key: `modifiers.${k}`, value: v });
    }

    return fields;
}

/**
 * A single field row with a copy button.
 * @param {{ fieldKey: string, value: string }} props
 * @returns {JSX.Element}
 */
function FieldRow({ fieldKey, value }) {
    const [copied, setCopied] = useState(false);

    async function handleCopy() {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <Box {...CARD_STYLES.entry}>
            <HStack justify="space-between" align="flex-start">
                <VStack align="flex-start" spacing={1} flex={1} minW={0}>
                    <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase">
                        {fieldKey}
                    </Text>
                    <Text {...TEXT_STYLES.entryText} wordBreak="break-all">{value}</Text>
                </VStack>
                <Tooltip label={copied ? "Copied!" : "Copy"} placement="left">
                    <IconButton
                        aria-label={`Copy ${fieldKey}`}
                        size="sm"
                        variant="ghost"
                        onClick={handleCopy}
                        icon={<span>{copied ? "✓" : "⎘"}</span>}
                        flexShrink={0}
                    />
                </Tooltip>
            </HStack>
        </Box>
    );
}

/**
 * Entry detail page. Displays all JSON fields for a single entry
 * with copy buttons on the right of each field.
 * @returns {JSX.Element}
 */
export default function EntryDetail() {
    const { id } = useParams();
    const location = useLocation();

    /** @type {Entry|null} */
    const stateEntry = location.state?.entry ?? null;

    const [entry, setEntry] = useState(stateEntry);
    const [isLoading, setIsLoading] = useState(stateEntry === null);
    const [notFound, setNotFound] = useState(false);

    useEffect(() => {
        if (stateEntry !== null || id === undefined) return;

        setIsLoading(true);
        fetchEntryById(id).then((fetched) => {
            if (fetched === null) {
                setNotFound(true);
            } else {
                setEntry(fetched);
            }
            setIsLoading(false);
        });
    }, [id, stateEntry]);

    if (isLoading) {
        return (
            <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
                <Box textAlign="center" py={SPACING.xxl}>
                    <Spinner size="md" color="blue.400" />
                </Box>
            </Container>
        );
    }

    if (notFound || entry === null) {
        return (
            <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
                <Card {...CARD_STYLES.secondary}>
                    <CardBody p={SPACING.lg}>
                        <Text {...TEXT_STYLES.helper} textAlign="center">Entry not found.</Text>
                    </CardBody>
                </Card>
            </Container>
        );
    }

    const fields = entryToFields(entry);

    return (
        <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
            <VStack spacing={SPACING.xxl} align="stretch" justify="flex-start">
                <Card {...CARD_STYLES.main}>
                    <CardBody p={SPACING.lg}>
                        <HStack spacing={2} mb={SPACING.md}>
                            <Badge {...BADGE_STYLES}>{entry.type}</Badge>
                        </HStack>
                        <VStack spacing={SPACING.sm} align="stretch">
                            {fields.map((field) => (
                                <FieldRow key={field.key} fieldKey={field.key} value={field.value} />
                            ))}
                        </VStack>
                    </CardBody>
                </Card>
            </VStack>
        </Container>
    );
}
