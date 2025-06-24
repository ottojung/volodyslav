import React, { useState, useEffect } from "react";
import {
    Box,
    VStack,
    HStack,
    Heading,
    Text,
    Code,
    Badge,
    Button,
    Collapse,
    useDisclosure,
    Card,
    CardBody,
    Tabs,
    TabList,
    TabPanels,
    Tab,
    TabPanel,
    Tooltip,
    Icon,
    Skeleton,
} from "@chakra-ui/react";
// Using built-in Chakra icons or creating simple ones
const ChevronDownIcon = () => <span>▼</span>;
const ChevronUpIcon = () => <span>▲</span>;
const InfoIcon = () => <span>ℹ️</span>;
const CopyIcon = () => <span>📋</span>;
import { fetchConfig } from "./api.js";
import { CARD_STYLES, TEXT_STYLES, SPACING, COLORS } from "./styles.js";

/**
 * @typedef {import('./api.js').Config} Config
 * @typedef {import('./api.js').Shortcut} Shortcut
 */

/**
 * Component that displays configuration help and shortcuts
 * @param {Object} props
 * @param {(value: string) => void} props.onShortcutClick - Called when a shortcut is clicked
 * @param {string} props.currentInput - Current input value to show preview
 */
export const ConfigSection = ({ onShortcutClick, currentInput = "" }) => {
    const [config, setConfig] = useState(/** @type {Config|null} */ (null));
    const [isLoading, setIsLoading] = useState(true);
    const { isOpen, onToggle } = useDisclosure({ defaultIsOpen: true });

    useEffect(() => {
        const loadConfig = async () => {
            setIsLoading(true);
            const configData = await fetchConfig();
            if (!configData) {
                // Fallback demo config for development
                const demoConfig = {
                    help: "Event logging help text\n\nSyntax: TYPE [MODIFIERS...] DESCRIPTION\n\nExamples:\n   food [certainty 9] earl gray tea, unsweetened\n   food [when now] [certainty 9] pizza capricciossa, medium size\n   sleep [when 5 hours ago] went to bed\n\nModifiers:\n   [when TIME] - specify when the event happened\n   [certainty LEVEL] - specify how certain you are (1-10)\n\nTypes available: food, sleep, exercise, work, social",
                    shortcuts: [
                        {
                            pattern: "breakfast",
                            replacement: "food [when this morning]",
                            description: "Quick breakfast entry",
                        },
                        {
                            pattern: "lunch",
                            replacement: "food [when noon]",
                            description: "Quick lunch entry",
                        },
                        {
                            pattern: "dinner",
                            replacement: "food [when evening]",
                            description: "Quick dinner entry",
                        },
                        {
                            pattern: "\\\\bcoffee\\\\b",
                            replacement: "food [certainty 10] coffee",
                            description: "Coffee shortcut",
                        },
                        {
                            pattern: "\\\\btea\\\\b",
                            replacement: "food [certainty 10] tea",
                            description: "Tea shortcut",
                        },
                        {
                            pattern: "slept (\\\\d+)h",
                            replacement: "sleep [duration $1 hours]",
                            description: "Sleep duration shortcut",
                        },
                        {
                            pattern: "worked (\\\\d+)h",
                            replacement: "work [duration $1 hours]",
                            description: "Work duration shortcut",
                        },
                    ],
                };
                setConfig(demoConfig);
            } else {
                setConfig(configData);
            }
            setIsLoading(false);
        };
        loadConfig();
    }, []);

    const handleShortcutClick = (/** @type {Shortcut} */ shortcut) => {
        // For demonstration, use the replacement text directly
        // In a real implementation, you might want to apply the regex transformation
        let exampleText = shortcut.replacement;

        // If it's a simple pattern, use the replacement directly
        if (
            !shortcut.pattern.includes("\\\\") &&
            !shortcut.pattern.includes("(")
        ) {
            exampleText = shortcut.replacement;
        } else {
            // For more complex patterns, show the description or a simple example
            exampleText =
                shortcut.description ||
                `${shortcut.pattern} → ${shortcut.replacement}`;
        }

        onShortcutClick(exampleText);
    };

    const applyShortcut = (
        /** @type {string} */ text,
        /** @type {Shortcut} */ shortcut
    ) => {
        try {
            const regex = new RegExp(shortcut.pattern, "g");
            return text.replace(regex, shortcut.replacement);
        } catch (error) {
            console.warn("Invalid regex pattern:", shortcut.pattern);
            return text;
        }
    };

    const getShortcutPreview = (/** @type {Shortcut} */ shortcut) => {
        if (!currentInput.trim()) return null;

        try {
            const regex = new RegExp(shortcut.pattern);
            if (regex.test(currentInput)) {
                const transformed = applyShortcut(currentInput, shortcut);
                if (transformed !== currentInput) {
                    return transformed;
                }
            }
        } catch (error) {
            // Invalid regex, ignore
        }
        return null;
    };

    if (isLoading) {
        return (
            <Card {...CARD_STYLES.main}>
                <CardBody p={SPACING.lg}>
                    <VStack spacing={SPACING.md}>
                        <Skeleton height="20px" />
                        <Skeleton height="16px" />
                        <Skeleton height="16px" />
                    </VStack>
                </CardBody>
            </Card>
        );
    }

    if (!config) {
        return null; // Don't show anything if no config
    }

    const syntaxExamples = [
        "food [certainty 9] earl gray tea, unsweetened",
        "food [when now] [certainty 9] pizza capricciossa, medium size",
        "food[when 5 hours ago][certainty 7]caesar salad with croutons",
        "food earl gray tea, unsweetened",
    ];

    return (
        <Card {...CARD_STYLES.main}>
            <CardBody p={SPACING.lg}>
                <VStack spacing={SPACING.md} align="stretch">
                    <HStack justify="space-between" align="center">
                        <HStack>
                            <Icon as={InfoIcon} color={COLORS.primary} />
                            <Heading size="md" {...TEXT_STYLES.cardHeading}>
                                Event Logging Help
                            </Heading>
                            {config.shortcuts.length > 0 && (
                                <Badge colorScheme="blue" variant="subtle">
                                    {config.shortcuts.length} shortcuts
                                </Badge>
                            )}
                        </HStack>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onToggle}
                            rightIcon={
                                isOpen ? <ChevronUpIcon /> : <ChevronDownIcon />
                            }
                        >
                            {isOpen ? "Hide" : "Show"} Details
                        </Button>
                    </HStack>

                    <Collapse in={isOpen} animateOpacity>
                        <VStack spacing={SPACING.lg} align="stretch">
                            <Tabs variant="soft-rounded" colorScheme="blue">
                                <TabList>
                                    <Tab>Syntax</Tab>
                                    {config.shortcuts.length > 0 && (
                                        <Tab>Shortcuts</Tab>
                                    )}
                                    {config.help && <Tab>Help</Tab>}
                                </TabList>

                                <TabPanels>
                                    {/* Syntax Examples Tab */}
                                    <TabPanel px={0}>
                                        <VStack
                                            spacing={SPACING.md}
                                            align="stretch"
                                        >
                                            <Text
                                                {...TEXT_STYLES.helper}
                                                fontWeight="medium"
                                            >
                                                Syntax: TYPE [MODIFIERS...]
                                                DESCRIPTION
                                            </Text>
                                            <Text
                                                fontSize="sm"
                                                color="gray.600"
                                            >
                                                Examples:
                                            </Text>
                                            <VStack
                                                spacing={SPACING.sm}
                                                align="stretch"
                                            >
                                                {syntaxExamples.map(
                                                    (example, index) => (
                                                        <HStack
                                                            key={index}
                                                            spacing={SPACING.sm}
                                                        >
                                                            <Code
                                                                fontSize="sm"
                                                                px={3}
                                                                py={2}
                                                                flex={1}
                                                                cursor="pointer"
                                                                _hover={{
                                                                    bg: "gray.100",
                                                                }}
                                                                onClick={() =>
                                                                    onShortcutClick(
                                                                        example
                                                                    )
                                                                }
                                                            >
                                                                {example}
                                                            </Code>
                                                            <Tooltip label="Click to use this example">
                                                                <Icon
                                                                    as={
                                                                        CopyIcon
                                                                    }
                                                                    color="gray.400"
                                                                    boxSize={3}
                                                                />
                                                            </Tooltip>
                                                        </HStack>
                                                    )
                                                )}
                                            </VStack>
                                        </VStack>
                                    </TabPanel>

                                    {/* Shortcuts Tab */}
                                    {config.shortcuts.length > 0 && (
                                        <TabPanel px={0}>
                                            <VStack
                                                spacing={SPACING.md}
                                                align="stretch"
                                            >
                                                <Text
                                                    fontSize="sm"
                                                    color="gray.600"
                                                >
                                                    Click a shortcut to see how
                                                    it works:
                                                </Text>
                                                {config.shortcuts.map(
                                                    (shortcut, index) => {
                                                        const preview =
                                                            getShortcutPreview(
                                                                shortcut
                                                            );
                                                        return (
                                                            <Card
                                                                key={index}
                                                                variant="outline"
                                                                size="sm"
                                                            >
                                                                <CardBody
                                                                    p={
                                                                        SPACING.md
                                                                    }
                                                                >
                                                                    <VStack
                                                                        spacing={
                                                                            SPACING.sm
                                                                        }
                                                                        align="stretch"
                                                                    >
                                                                        <HStack
                                                                            justify="space-between"
                                                                            cursor="pointer"
                                                                            onClick={() =>
                                                                                handleShortcutClick(
                                                                                    shortcut
                                                                                )
                                                                            }
                                                                            _hover={{
                                                                                bg: "gray.50",
                                                                            }}
                                                                            p={
                                                                                2
                                                                            }
                                                                            borderRadius="md"
                                                                        >
                                                                            <HStack
                                                                                spacing={
                                                                                    SPACING.sm
                                                                                }
                                                                            >
                                                                                <Code
                                                                                    colorScheme="blue"
                                                                                    fontSize="xs"
                                                                                >
                                                                                    {
                                                                                        shortcut.pattern
                                                                                    }
                                                                                </Code>
                                                                                <Text color="gray.500">
                                                                                    →
                                                                                </Text>
                                                                                <Code
                                                                                    colorScheme="green"
                                                                                    fontSize="xs"
                                                                                >
                                                                                    {
                                                                                        shortcut.replacement
                                                                                    }
                                                                                </Code>
                                                                            </HStack>
                                                                            <Icon
                                                                                as={
                                                                                    CopyIcon
                                                                                }
                                                                                color="gray.400"
                                                                                boxSize={
                                                                                    3
                                                                                }
                                                                            />
                                                                        </HStack>
                                                                        {shortcut.description && (
                                                                            <Text
                                                                                fontSize="xs"
                                                                                color="gray.600"
                                                                            >
                                                                                {
                                                                                    shortcut.description
                                                                                }
                                                                            </Text>
                                                                        )}
                                                                        {preview && (
                                                                            <Box
                                                                                bg="blue.50"
                                                                                p={
                                                                                    2
                                                                                }
                                                                                borderRadius="md"
                                                                                borderLeft="3px solid"
                                                                                borderLeftColor="blue.300"
                                                                            >
                                                                                <Text
                                                                                    fontSize="xs"
                                                                                    color="blue.700"
                                                                                    fontWeight="medium"
                                                                                >
                                                                                    Preview:
                                                                                    &ldquo;
                                                                                    {
                                                                                        currentInput
                                                                                    }
                                                                                    &rdquo;
                                                                                    →
                                                                                    &ldquo;
                                                                                    {
                                                                                        preview
                                                                                    }
                                                                                    &rdquo;
                                                                                </Text>
                                                                            </Box>
                                                                        )}
                                                                    </VStack>
                                                                </CardBody>
                                                            </Card>
                                                        );
                                                    }
                                                )}
                                            </VStack>
                                        </TabPanel>
                                    )}

                                    {/* Help Tab */}
                                    {config.help && (
                                        <TabPanel px={0}>
                                            <Box
                                                bg="gray.50"
                                                p={SPACING.md}
                                                borderRadius="md"
                                                borderLeft="4px solid"
                                                borderLeftColor="blue.400"
                                            >
                                                <Text
                                                    fontSize="sm"
                                                    whiteSpace="pre-wrap"
                                                >
                                                    {config.help}
                                                </Text>
                                            </Box>
                                        </TabPanel>
                                    )}
                                </TabPanels>
                            </Tabs>
                        </VStack>
                    </Collapse>
                </VStack>
            </CardBody>
        </Card>
    );
};
