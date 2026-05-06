import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
    Box,
    Button,
    Heading,
    Spinner,
    Text,
    VStack,
} from "@chakra-ui/react";
import MarkdownIt from "markdown-it";
import "./markdown.css";
import { fetchDiarySummary, runDiarySummary } from "./api.js";
import { DiarySummaryEntryList } from "./DiarySummaryEntryList.jsx";
import { useToast } from "../toast.jsx";

/**
 * @typedef {import('./api.js').DiarySummaryData} DiarySummaryData
 * @typedef {import('./api.js').DiarySummaryRunEntry} DiarySummaryRunEntry
 */

const markdownIt = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
});

/**
 * @returns {DiarySummaryData | null}
 */
function getInitialSummary() {
    return null;
}

/**
 * Renders the summary markdown.
 * @param {{ markdown: string }} props
 * @returns {React.JSX.Element}
 */
function MarkdownText({ markdown }) {
    const html = markdownIt.render(markdown);
    return (
        <Box
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

/**
 * @returns {'loading' | 'ready' | 'error'}
 */
function getInitialLoadState() {
    return "loading";
}

/**
 * @returns {DiarySummaryRunEntry[]}
 */
function getInitialRunEntries() {
    return [];
}

/**
 * Diary Summary page component.
 * Shows the current rolling diary summary and allows triggering an update.
 * @returns {React.JSX.Element}
 */
export default function DiarySummary() {
    const [summary, setSummary] = useState(getInitialSummary());
    const [loadState, setLoadState] = useState(getInitialLoadState());
    const [isRunning, setIsRunning] = useState(false);
    const [runEntries, setRunEntries] = useState(getInitialRunEntries());
    /** @type {import('react').MutableRefObject<AbortController | null>} */
    const runAbortControllerRef = useRef(null);
    const toast = useToast();

    useEffect(() => {
        return () => {
            runAbortControllerRef.current?.abort();
        };
    }, []);

    useEffect(() => {
        let isMounted = true;

        async function load() {
            const data = await fetchDiarySummary();
            if (!isMounted) return;
            if (data === null) {
                setLoadState("error");
            } else {
                setSummary(data);
                setLoadState("ready");
            }
        }

        void load();

        return () => {
            isMounted = false;
        };
    }, []);

    async function handleRun() {
        const abortController = new AbortController();
        runAbortControllerRef.current?.abort();
        runAbortControllerRef.current = abortController;

        setIsRunning(true);
        setRunEntries([]);
        try {
            const result = await runDiarySummary((entries) => {
                if (!abortController.signal.aborted) {
                    setRunEntries([...entries]);
                }
            }, abortController.signal);
            if (abortController.signal.aborted) {
                return;
            }
            if (result.success && result.summary) {
                setSummary(result.summary);
                setLoadState("ready");
                toast({ title: "Diary summary updated.", status: "success" });
            } else if (result.notAnalyzer) {
                toast({
                    title: result.error,
                    status: "error",
                });
            } else {
                setLoadState("error");
                toast({ title: "Failed to run diary summary.", status: "error" });
            }
        } finally {
            if (!abortController.signal.aborted) {
                setIsRunning(false);
            }
        }
    }

    return (
        <Box p={6}>
            <VStack gap={4} align="stretch">
                <Box>
                    <Link to="/">
                        <Button variant="ghost" size="sm">← Back</Button>
                    </Link>
                </Box>

                <Heading size="lg">Diary Summary</Heading>

                <Button
                    colorPalette="teal"
                    onClick={handleRun}
                    loading={isRunning}
                    disabled={isRunning}
                    w="fit-content"
                >
                    Update Summary
                </Button>

                {(isRunning || runEntries.length > 0) && (
                    <DiarySummaryEntryList entries={runEntries} isRunning={isRunning} />
                )}

                {loadState === "loading" && (
                    <Box display="flex" alignItems="center" gap={2}>
                        <Spinner size="sm" />
                        <Text>Loading summary…</Text>
                    </Box>
                )}

                {loadState === "error" && (
                    <Text color="red.500">Failed to load diary summary.</Text>
                )}

                {loadState === "ready" && summary !== null && (
                    <Box>
                        {summary.updatedAt && (
                            <Text fontSize="xs" color="gray.500" mb={2}>
                                Last updated: {summary.updatedAt}
                                {summary.summaryDate ? ` · Summary through: ${summary.summaryDate}` : ""}
                            </Text>
                        )}
                        <Box
                            borderWidth="1px"
                            borderRadius="md"
                            p={4}
                            bg="gray.50"
                        >
                            <MarkdownText markdown={summary.markdown} />
                        </Box>
                    </Box>
                )}
            </VStack>
        </Box>
    );
}
