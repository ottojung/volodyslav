import React, { useState, useRef, useEffect } from "react";
import { Link, useNavigationType } from "react-router-dom";
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
import { getEntryParsed } from "../DescriptionEntry/entry.js";
import {
    SPACING,
    SIZES,
    CARD_STYLES,
    INPUT_STYLES,
    TEXT_STYLES,
    BADGE_STYLES,
    BUTTON_STYLES,
} from "../DescriptionEntry/styles.js";

const SEARCH_STATE_KEY = "volodyslav_search_state";

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
    const inputRef = useRef(null);
    const searchSequenceRef = useRef(0);
    // Tracks whether the initial fetch should be skipped because state was restored.
    const isStateRestoredRef = useRef(restoredState !== null);

    useEffect(() => {
        if (inputRef.current) {
            // @ts-expect-error: inputRef is not typed, but focus() is valid for Chakra Input
            inputRef.current.focus();
        }
    }, []);

    useEffect(() => {
        setError(null);

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
                                                <VStack align="flex-start" spacing={1} flex={1}>
                                                    <HStack spacing={2}>
                                                        <Badge {...BADGE_STYLES}>{entryType}</Badge>
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
                        </CardBody>
                    </Card>
                )}

                {!isLoading && error === null && hasMore && !isLoadingMore && (
                    <Box textAlign="center">
                        <Button {...BUTTON_STYLES.primary} onClick={handleLoadMore}>
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
