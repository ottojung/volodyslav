import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
    Container,
    VStack,
    Card,
    CardBody,
    Input,
    Text,
    Box,
    HStack,
    Badge,
    Spinner,
    Button,
} from "@chakra-ui/react";
import { searchEntries } from "./api.js";
import { formatRelativeDate } from "../DescriptionEntry/utils.js";
import {
    SPACING,
    SIZES,
    CARD_STYLES,
    INPUT_STYLES,
    TEXT_STYLES,
    BADGE_STYLES,
    BUTTON_STYLES,
} from "../DescriptionEntry/styles.js";

/**
 * @typedef {import('../DescriptionEntry/entry.js').Entry} Entry
 */

/** @type {Entry[]} */
const EMPTY_ENTRIES = [];
/** @type {string|null} */
const NO_ERROR = null;

/**
 * Search page component.
 * Shows a regex search field at the top and matching entries below.
 * Clicking an entry navigates to its detail page.
 * @returns {JSX.Element}
 */
export default function Search() {
    const [pattern, setPattern] = useState("");
    const [results, setResults] = useState(EMPTY_ENTRIES);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(NO_ERROR);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const inputRef = useRef(null);
    const searchSequenceRef = useRef(0);
    const navigate = useNavigate();

    useEffect(() => {
        if (inputRef.current) {
            // @ts-expect-error: inputRef is not typed, but focus() is valid for Chakra Input
            inputRef.current.focus();
        }
    }, []);

    useEffect(() => {
        setIsLoading(true);
        setError(null);

        const sequence = ++searchSequenceRef.current;

        const timer = setTimeout(async () => {
            const { results: found, hasMore: more, error: err } = await searchEntries(pattern, 1);
            if (sequence !== searchSequenceRef.current) return;
            setResults(found);
            setPage(1);
            setHasMore(more);
            setError(err !== undefined ? err : null);
            setIsLoading(false);
        }, 300);

        return () => clearTimeout(timer);
    }, [pattern]);

    /**
     * @param {Entry} entry
     */
    function handleEntryClick(entry) {
        navigate(`/entry/${entry.id}`, { state: { entry } });
    }

    async function handleLoadMore() {
        const nextPage = page + 1;
        setIsLoading(true);
        const { results: found, hasMore: more, error: err } = await searchEntries(pattern, nextPage);
        if (err === undefined) {
            setResults(prev => [...prev, ...found]);
            setPage(nextPage);
            setHasMore(more);
        } else {
            setError(err);
        }
        setIsLoading(false);
    }

    return (
        <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
            <VStack spacing={SPACING.xxl} align="stretch" justify="flex-start" minH="70vh">
                <Card {...CARD_STYLES.main}>
                    <CardBody p={SPACING.xl}>
                        <Input
                            placeholder="Search entries by regex..."
                            value={pattern}
                            onChange={(e) => setPattern(e.target.value)}
                            ref={inputRef}
                            {...INPUT_STYLES}
                        />
                    </CardBody>
                </Card>

                {isLoading && (
                    <Box textAlign="center" py={SPACING.lg}>
                        <Spinner size="md" color="blue.400" />
                    </Box>
                )}

                {error !== null && (
                    <Card {...CARD_STYLES.secondary}>
                        <CardBody p={SPACING.lg}>
                            <Text color="red.500" fontSize="sm">{error}</Text>
                        </CardBody>
                    </Card>
                )}

                {!isLoading && error === null && results.length > 0 && (
                    <Card {...CARD_STYLES.main}>
                        <CardBody p={SPACING.lg}>
                            <VStack spacing={SPACING.sm} align="stretch">
                                {results.map((entry, index) => (
                                    <Box
                                        key={entry.id || index}
                                        {...CARD_STYLES.entry}
                                        cursor="pointer"
                                        _hover={{ bg: "gray.100" }}
                                        onClick={() => handleEntryClick(entry)}
                                    >
                                        <HStack justify="space-between" align="flex-start">
                                            <VStack align="flex-start" spacing={1} flex={1}>
                                                <HStack spacing={2}>
                                                    <Badge {...BADGE_STYLES}>{entry.type}</Badge>
                                                    <Text {...TEXT_STYLES.entryMeta}>
                                                        {formatRelativeDate(entry.date)}
                                                    </Text>
                                                </HStack>
                                                <Text {...TEXT_STYLES.entryText}>{entry.description}</Text>
                                            </VStack>
                                        </HStack>
                                    </Box>
                                ))}
                            </VStack>
                        </CardBody>
                    </Card>
                )}

                {!isLoading && error === null && hasMore && (
                    <Box textAlign="center">
                        <Button {...BUTTON_STYLES.primary} onClick={handleLoadMore}>
                            Load more
                        </Button>
                    </Box>
                )}

                {!isLoading && error === null && results.length > 0 && !hasMore && (
                    <Card {...CARD_STYLES.secondary}>
                        <CardBody p={SPACING.lg}>
                            <Text {...TEXT_STYLES.helper} textAlign="center">
                                All matching entries are displayed.
                            </Text>
                        </CardBody>
                    </Card>
                )}

                {!isLoading && error === null && pattern.trim() !== "" && results.length === 0 && (
                    <Card {...CARD_STYLES.secondary}>
                        <CardBody p={SPACING.lg}>
                            <Text {...TEXT_STYLES.helper} textAlign="center">
                                No entries match your search.
                            </Text>
                        </CardBody>
                    </Card>
                )}
            </VStack>
        </Container>
    );
}
