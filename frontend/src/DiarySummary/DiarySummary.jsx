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
import { fetchDiarySummary, runDiarySummary } from "./api.js";
import { useToast } from "../toast.jsx";

/**
 * @typedef {import('./api.js').DiarySummaryData} DiarySummaryData
 */

/**
 * @returns {DiarySummaryData | null}
 */
function getInitialSummary() {
    return null;
}

/**
 * Renders the summary markdown as simple paragraphs and bullet lists.
 * This avoids requiring a Markdown library dependency.
 * @param {{ markdown: string }} props
 * @returns {React.JSX.Element}
 */
function MarkdownText({ markdown }) {
    const lines = markdown.split("\n");
    /** @type {React.JSX.Element[]} */
    const elements = [];
    let key = 0;

    for (const line of lines) {
        if (line.startsWith("## ")) {
            elements.push(
                <Heading key={key++} as="h2" size="md" mt={4} mb={2}>
                    {line.slice(3)}
                </Heading>
            );
        } else if (line.startsWith("- ")) {
            elements.push(
                <Text key={key++} pl={4} mb={1}>
                    {"• "}{line.slice(2)}
                </Text>
            );
        } else if (line.trim() === "") {
            elements.push(<Box key={key++} h={1} />);
        } else {
            elements.push(
                <Text key={key++} mb={1}>
                    {line}
                </Text>
            );
        }
    }

    return <Box>{elements}</Box>;
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
        try {
            const data = await runDiarySummary();
            if (data !== null) {
                setSummary(data);
                toast({ title: "Diary summary updated.", status: "success" });
            } else {
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
