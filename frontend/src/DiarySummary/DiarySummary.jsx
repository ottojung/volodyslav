import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
    Box,
    Button,
    Heading,
    Spinner,
    Text,
    VStack,
} from "@chakra-ui/react";
import { marked } from "marked";
import "./markdown.css";
import { fetchDiarySummary, runDiarySummary } from "./api.js";
import { DiarySummaryEntryList } from "./DiarySummaryEntryList.jsx";
import { useToast } from "../toast.jsx";

/**
 * @typedef {import('./api.js').DiarySummaryData} DiarySummaryData
 * @typedef {import('./api.js').DiarySummaryRunEntry} DiarySummaryRunEntry
 */

/**
 * @returns {DiarySummaryData | null}
 */
function getInitialSummary() {
    return null;
}

/**
 * Renders the summary markdown using the marked library.
 * @param {{ markdown: string }} props
 * @returns {React.JSX.Element}
 */
function MarkdownText({ markdown }) {
    const html = marked.parse(markdown, { gfm: true });
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
 * Diary Summary page component.
 * Shows the current rolling diary summary and allows triggering an update.
 * @returns {React.JSX.Element}
 */
export default function DiarySummary() {
    const [summary, setSummary] = useState(getInitialSummary());
    const [loadState, setLoadState] = useState(getInitialLoadState());
    const [isRunning, setIsRunning] = useState(false);
    /** @type {[DiarySummaryRunEntry[], React.Dispatch<React.SetStateAction<DiarySummaryRunEntry[]>>]} */
    const [runEntries, setRunEntries] = useState(/** @type {DiarySummaryRunEntry[]} */ ([]));
    const toast = useToast();

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
        setIsRunning(true);
        setRunEntries([]);
        try {
            const result = await runDiarySummary((entries) => {
                setRunEntries([...entries]);
            });
            if (result.success && result.summary) {
                setSummary(result.summary);
                setLoadState("ready");
                toast({ title: "Diary summary updated.", status: "success" });
            } else {
                setLoadState("error");
                toast({ title: "Failed to run diary summary.", status: "error" });
            }
        } finally {
            setIsRunning(false);
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
