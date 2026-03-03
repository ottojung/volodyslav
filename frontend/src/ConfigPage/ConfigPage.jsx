import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
    Button,
    Card,
    CardBody,
    Container,
    FormControl,
    Heading,
    HStack,
    Spinner,
    Text,
    Textarea,
    VStack,
    useToast,
} from "@chakra-ui/react";
import { fetchConfig, updateConfig } from "../DescriptionEntry/api.js";
import { ShortcutRow } from "./ShortcutRow.jsx";

/**
 * @typedef {import('../DescriptionEntry/api.js').Config} Config
 * @typedef {import('../DescriptionEntry/api.js').Shortcut} Shortcut
 */

/**
 * @typedef {object} KeyedShortcut
 * @property {number} key - Stable unique key for React rendering
 * @property {Shortcut} shortcut - The shortcut tuple
 */

/**
 * @returns {KeyedShortcut[]}
 */
function getInitialKeyedShortcuts() {
    return [];
}

/**
 * Page for managing the configuration (shortcuts and help text).
 * @returns {JSX.Element}
 */
export default function ConfigPage() {
    /** @type {[string, React.Dispatch<React.SetStateAction<string>>]} */
    const [help, setHelp] = useState("");
    /** @type {[KeyedShortcut[], React.Dispatch<React.SetStateAction<KeyedShortcut[]>>]} */
    const [keyedShortcuts, setKeyedShortcuts] = useState(getInitialKeyedShortcuts());
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const nextKey = useRef(0);
    const toast = useToast();

    /**
     * @param {Shortcut} shortcut
     * @returns {KeyedShortcut}
     */
    function wrapWithKey(shortcut) {
        const key = nextKey.current;
        nextKey.current += 1;
        return { key, shortcut };
    }

    useEffect(() => {
        const load = async () => {
            setIsLoading(true);
            const config = await fetchConfig();
            if (config) {
                setHelp(config.help);
                let keyCounter = 0;
                setKeyedShortcuts(config.shortcuts.map((s) => {
                    const k = keyCounter;
                    keyCounter += 1;
                    nextKey.current = keyCounter;
                    return { key: k, shortcut: s };
                }));
            } else {
                setHelp("");
                setKeyedShortcuts([]);
            }
            setIsLoading(false);
        };
        load();
    }, []);

    /**
     * @param {number} rowKey
     * @param {Shortcut} updated
     */
    function handleShortcutChange(rowKey, updated) {
        setKeyedShortcuts((prev) =>
            prev.map((ks) => ks.key === rowKey ? { key: ks.key, shortcut: updated } : ks)
        );
    }

    /** @param {number} rowKey */
    function handleShortcutDelete(rowKey) {
        setKeyedShortcuts((prev) => prev.filter((ks) => ks.key !== rowKey));
    }

    function handleAddShortcut() {
        /** @type {Shortcut} */
        const empty = ["", ""];
        const keyed = wrapWithKey(empty);
        setKeyedShortcuts((prev) => [...prev, keyed]);
    }

    async function handleSave() {
        for (const [index, { shortcut }] of keyedShortcuts.entries()) {
            const [pattern] = shortcut;
            if (pattern === "") {
                toast({
                    title: "Invalid shortcut.",
                    description: `Shortcut #${index + 1} has an empty pattern. Please fill in the pattern or delete the shortcut.`,
                    status: "error",
                    duration: 5000,
                    isClosable: true,
                });
                return;
            }
            try {
                new RegExp(pattern);
            } catch {
                toast({
                    title: "Invalid shortcut.",
                    description: `Shortcut #${index + 1} has an invalid regex pattern "${pattern}".`,
                    status: "error",
                    duration: 5000,
                    isClosable: true,
                });
                return;
            }
        }

        setIsSaving(true);
        const shortcuts = keyedShortcuts.map((ks) => ks.shortcut);
        const result = await updateConfig({ help, shortcuts });
        setIsSaving(false);

        if (result !== null) {
            toast({
                title: "Configuration saved.",
                status: "success",
                duration: 3000,
                isClosable: true,
            });
        } else {
            toast({
                title: "Failed to save configuration.",
                description: "Please check your input and try again.",
                status: "error",
                duration: 5000,
                isClosable: true,
            });
        }
    }

    if (isLoading) {
        return (
            <Container maxW="2xl" py={8}>
                <VStack spacing={4} align="center">
                    <Spinner size="xl" />
                    <Text>Loading configuration...</Text>
                </VStack>
            </Container>
        );
    }

    return (
        <Container maxW="2xl" py={6}>
            <VStack spacing={6} align="stretch">
                <HStack justify="space-between">
                    <Heading size="lg">Configuration</Heading>
                    <Link to="/">
                        <Button variant="ghost" size="sm">← Back</Button>
                    </Link>
                </HStack>

                <Card shadow="md" borderRadius="xl">
                    <CardBody>
                        <VStack spacing={4} align="stretch">
                            <Heading size="sm">Help Text</Heading>
                            <FormControl>
                                <Textarea
                                    value={help}
                                    onChange={(e) => setHelp(e.target.value)}
                                    placeholder="Help text shown to users..."
                                    rows={4}
                                />
                            </FormControl>
                        </VStack>
                    </CardBody>
                </Card>

                <Card shadow="md" borderRadius="xl">
                    <CardBody>
                        <VStack spacing={4} align="stretch">
                            <HStack justify="space-between">
                                <Heading size="sm">Shortcuts</Heading>
                                <Button
                                    size="sm"
                                    colorScheme="blue"
                                    onClick={handleAddShortcut}
                                >
                                    + Add Shortcut
                                </Button>
                            </HStack>

                            {keyedShortcuts.length === 0 && (
                                <Text fontSize="sm" color="gray.500" textAlign="center" py={4}>
                                    No shortcuts yet. Click &ldquo;Add Shortcut&rdquo; to create one.
                                </Text>
                            )}

                            {keyedShortcuts.map(({ key, shortcut }) => (
                                <ShortcutRow
                                    key={key}
                                    shortcut={shortcut}
                                    rowKey={key}
                                    onChange={handleShortcutChange}
                                    onDelete={handleShortcutDelete}
                                />
                            ))}
                        </VStack>
                    </CardBody>
                </Card>

                <Button
                    colorScheme="blue"
                    size="lg"
                    onClick={handleSave}
                    isLoading={isSaving}
                    loadingText="Saving..."
                >
                    Save Configuration
                </Button>
            </VStack>
        </Container>
    );
}
