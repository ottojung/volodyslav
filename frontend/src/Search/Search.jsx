import React, { useState, useRef, useEffect } from "react";
import { Link, useNavigationType } from "react-router-dom";
import { Container, VStack, Card, Input, Text, Box, HStack, Badge, Spinner, Button } from "@chakra-ui/react";
import { searchEntries, fetchAdditionalProperties } from "./api.js";
import { formatRelativeDate } from "../DescriptionEntry/utils.js";
import { getEntryParsed } from "../DescriptionEntry/entry.js";
import { logger } from "../DescriptionEntry/logger.js";
import {
    SPACING,
    SIZES,
    CARD_STYLES,
    TEXT_STYLES,
    INPUT_STYLES,
} from "../DescriptionEntry/styles.js";

const SEARCH_STATE_KEY = "volodyslav_search_state";

const COPY_STATUS_IDLE = 'idle';
const COPY_STATUS_SUCCESS = 'success';
const COPY_STATUS_ERROR = 'error';

/**
 * @typedef {import('../DescriptionEntry/entry.js').Entry} Entry
 */

/** @type {Entry[]} */
const EMPTY_ENTRIES = [];
/** @type {string|null} */
const NO_ERROR = null;

/**
 * Saves the current search state to sessionStorage so it can be restored
 * when the user navigates back.
 * @param {string} pattern
 * @param {Entry[]} results
 * @param {number} page
 * @param {boolean} hasMore
 * @param {string|null} error
 */
function saveSearchState(pattern, results, page, hasMore, error) {
    try {
        sessionStorage.setItem(
            SEARCH_STATE_KEY,
            JSON.stringify({ pattern, results, page, hasMore, error })
        );
    } catch {
        // sessionStorage might be unavailable in some environments
    }
}

/**
 * Loads previously saved search state from sessionStorage.
 * @returns {{ pattern: string, results: Entry[], page: number, hasMore: boolean, error: string|null } | null}
 */
function loadSearchState() {
    try {
        const saved = sessionStorage.getItem(SEARCH_STATE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch {
        // ignore parse errors
    }
    return null;
}

/**
 * Search page component.
 * Shows a regex search field at the top and matching entries below.
 * Clicking an entry navigates to its detail page.
 * @returns {React.JSX.Element}
 */
export default function Search() {
    const navigationType = useNavigationType();

    // The lazy useState initializer captures navigationType from the current render's scope
    // and runs only once on mount, giving us the correct "back navigation" state.
    const [restoredState] = useState(() => navigationType === "POP" ? loadSearchState() : null);

    const [pattern, setPattern] = useState(restoredState?.pattern ?? "");
    const [results, setResults] = useState(restoredState?.results ?? EMPTY_ENTRIES);
    const [isLoading, setIsLoading] = useState(restoredState === null);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [error, setError] = useState(restoredState?.error ?? NO_ERROR);
    const [page, setPage] = useState(restoredState?.page ?? 1);
    const [hasMore, setHasMore] = useState(restoredState?.hasMore ?? false);
    const [isCopying, setIsCopying] = useState(false);
    const [copyStatus, setCopyStatus] = useState(COPY_STATUS_IDLE);
    const inputRef = useRef(null);
    const searchSequenceRef = useRef(0);
    const copySequenceRef = useRef(0);
    // Tracks whether the initial fetch should be skipped because state was restored.
    const isStateRestoredRef = useRef(restoredState !== null);

    useEffect(() => {
        if (restoredState !== null) {
            return;
        }
        if (inputRef.current) {
            // @ts-expect-error: inputRef is not typed, but focus() is valid for Chakra Input
            inputRef.current.focus();
        }
    }, [restoredState]);

    useEffect(() => {
        setError(null);
        setCopyStatus(COPY_STATUS_IDLE);
        setIsCopying(false);
        ++copySequenceRef.current;

        if (isStateRestoredRef.current) {
            isStateRestoredRef.current = false;
            return;
        }

        setIsLoading(true);
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
     * Saves current search state before navigating to an entry so the state
     * can be restored when the user presses the browser back button.
     */
    function handleEntryLinkClick() {
        saveSearchState(pattern, results, page, hasMore, error);
    }

    async function handleLoadMore() {
        const nextPage = page + 1;
        setIsLoadingMore(true);
        const { results: found, hasMore: more, error: err } = await searchEntries(pattern, nextPage);
        if (err === undefined) {
            setResults(prev => [...prev, ...found]);
            setPage(nextPage);
            setHasMore(more);
        } else {
            setError(err);
        }
        setIsLoadingMore(false);
    }

    async function handleCopy() {
        const copySequence = ++copySequenceRef.current;
        setIsCopying(true);
        setCopyStatus(COPY_STATUS_IDLE);
        try {
            const items = await Promise.all(
                results.map(async (entry) => {
                    const props = await fetchAdditionalProperties(entry.id, "basic_context");
                    return {
                        input: entry.input,
                        date: entry.date,
                        basicContext: (props.basic_context ?? []).map((item) => ({
                            input: item.input,
                            date: item.date,
                        })),
                    };
                })
            );
            if (copySequence !== copySequenceRef.current) return;
            await navigator.clipboard.writeText(JSON.stringify(items, null, 2));
            if (copySequence !== copySequenceRef.current) return;
            setCopyStatus(COPY_STATUS_SUCCESS);
        } catch (err) {
            logger.error("Failed to copy entries to clipboard:", err);
            if (copySequence !== copySequenceRef.current) return;
            setCopyStatus(COPY_STATUS_ERROR);
        }
        if (copySequence !== copySequenceRef.current) return;
        setIsCopying(false);
    }

    return (
        <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
            <VStack gap={SPACING.xxl} align="stretch" justify="flex-start" minH="70vh">
                <Card.Root {...CARD_STYLES.main}>
                    <Card.Body p={SPACING.xl}>
                        <Input
                            placeholder="Search entries by regex..."
                            value={pattern}
                            onChange={(e) => setPattern(e.target.value)}
                            ref={inputRef}
                            {...INPUT_STYLES}
                        />
                    </Card.Body>
                </Card.Root>

                {isLoading && (
                    <Box textAlign="center" py={SPACING.lg}>
                        <Spinner size="md" color="blue.400" />
                    </Box>
                )}

                {error !== null && (
                    <Card.Root {...CARD_STYLES.secondary}>
                        <Card.Body p={SPACING.lg}>
                            <Text color="red.500" fontSize="sm">{error}</Text>
                        </Card.Body>
                    </Card.Root>
                )}

                {!isLoading && error === null && results.length > 0 && (
                    <Card.Root {...CARD_STYLES.main}>
                        <Card.Body p={SPACING.lg}>
                            <VStack gap={SPACING.sm} align="stretch">
                                {results.map((entry, index) => {
                                    const { type: entryType, description: entryDescription } = getEntryParsed(entry);
                                    return (
                                        <Link
                                            key={entry.id || index}
                                            to={`/entry/${entry.id}`}
                                            state={{ entry }}
                                            onClick={handleEntryLinkClick}
                                            style={{ textDecoration: "none", color: "inherit", display: "block" }}
                                        >
                                            <Box
                                                {...CARD_STYLES.entry}
                                                cursor="pointer"
                                                _hover={{ bg: "gray.100" }}
                                            >
                                                <HStack justify="space-between" align="flex-start">
                                                    <VStack align="flex-start" gap={1} flex={1}>
                                                        <HStack gap={2}>
                                                            <Badge colorPalette="blue" variant="subtle">{entryType}</Badge>
                                                            <Text {...TEXT_STYLES.entryMeta}>
                                                                {formatRelativeDate(entry.date)}
                                                            </Text>
                                                        </HStack>
                                                        <Text {...TEXT_STYLES.entryText}>{entryDescription}</Text>
                                                    </VStack>
                                                </HStack>
                                            </Box>
                                        </Link>
                                    );
                                })}
                            </VStack>
                        </Card.Body>
                    </Card.Root>
                )}

                {!isLoading && error === null && hasMore && !isLoadingMore && (
                    <Box textAlign="center">
                        <Button colorPalette="blue" size="md" px={8} borderRadius="xl" onClick={handleLoadMore}>
                            Load more
                        </Button>
                    </Box>
                )}

                {isLoadingMore && (
                    <Box textAlign="center" py={SPACING.lg}>
                        <Spinner size="md" color="blue.400" />
                    </Box>
                )}

                {!isLoading && !isLoadingMore && error === null && results.length > 0 && !hasMore && (
                    <Card.Root {...CARD_STYLES.secondary}>
                        <Card.Body p={SPACING.lg}>
                            <Text {...TEXT_STYLES.helper} textAlign="center">
                                All matching entries are displayed.
                            </Text>
                        </Card.Body>
                    </Card.Root>
                )}

                {!isLoading && error === null && pattern.trim() !== "" && results.length === 0 && (
                    <Card.Root {...CARD_STYLES.secondary}>
                        <Card.Body p={SPACING.lg}>
                            <Text {...TEXT_STYLES.helper} textAlign="center">
                                No entries match your search.
                            </Text>
                        </Card.Body>
                    </Card.Root>
                )}

                {!isLoading && !isLoadingMore && error === null && results.length > 0 && (
                    <Box textAlign="center">
                        <Button
                            colorPalette="teal"
                            size="md"
                            px={8}
                            borderRadius="xl"
                            onClick={handleCopy}
                            loading={isCopying}
                            loadingText="Copying..."
                        >
                            Copy as JSON
                        </Button>
                        {copyStatus === COPY_STATUS_SUCCESS && (
                            <Text fontSize="sm" color="teal.600" mt={2}>
                                Copied to clipboard!
                            </Text>
                        )}
                        {copyStatus === COPY_STATUS_ERROR && (
                            <Text fontSize="sm" color="red.500" mt={2}>
                                Failed to copy to clipboard.
                            </Text>
                        )}
                    </Box>
                )}
            </VStack>
        </Container>
    );
}
