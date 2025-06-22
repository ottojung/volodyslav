import React, { useState, useRef, useEffect } from "react";
import {
    Box,
    VStack,
    Heading,
    Input,
    Button,
    Text,
    useToast,
    Card,
    CardBody,
    Container,
    HStack,
    Skeleton,
    Badge,
    Divider,
} from "@chakra-ui/react";
import { Link } from "react-router-dom";

/**
 * @typedef {Object} Entry
 * @property {string} id - Unique identifier for the entry
 * @property {string} date - ISO date string
 * @property {string} type - Type of the entry
 * @property {string} description - Description of the entry
 * @property {string} input - Processed input
 * @property {string} original - Original input
 * @property {Object} modifiers - Entry modifiers
 * @property {Object} creator - Entry creator info
 */

export default function DescriptionEntry() {
    const [description, setDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    /** @type {[Entry[], Function]} */
    const [recentEntries, setRecentEntries] = useState([]);
    const [isLoadingEntries, setIsLoadingEntries] = useState(true);
    const toast = useToast();

    // Ref for the input field
    const inputRef = useRef(null);

    useEffect(() => {
        if (inputRef.current) {
            // @ts-expect-error: inputRef is not typed, but focus() is valid for Chakra Input
            inputRef.current.focus();
        }
        // Fetch recent entries on component mount
        fetchRecentEntries();
    }, []);

    // For now, use the same default as the Python script
    const API_BASE_URL = "/api";

    const fetchRecentEntries = async () => {
        try {
            setIsLoadingEntries(true);
            const response = await fetch(`${API_BASE_URL}/entries?limit=5`);

            if (response.ok) {
                const data = await response.json();
                setRecentEntries(data.results || []);
            } else {
                console.warn(
                    "Failed to fetch recent entries:",
                    response.status
                );
            }
        } catch (error) {
            console.error("Error fetching recent entries:", error);
        } finally {
            setIsLoadingEntries(false);
        }
    };

    const handleSubmit = async () => {
        if (!description.trim()) {
            toast({
                title: "Empty description",
                description: "Please enter a description before saving.",
                status: "warning",
                duration: 3000,
                isClosable: true,
                position: "top",
            });
            return;
        }

        setIsSubmitting(true);

        try {
            // Make real API call to Volodyslav backend
            const response = await fetch(`${API_BASE_URL}/entries`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    rawInput: description.trim(),
                }),
            });

            if (response.status === 201) {
                const result = await response.json();

                if (result.success) {
                    const entry = result.entry || {};
                    const savedInput = entry.input || description.trim();

                    setDescription("");

                    // Refresh recent entries
                    fetchRecentEntries();

                    toast({
                        title: "Event logged successfully",
                        description: `Saved: ${savedInput}`,
                        status: "success",
                        duration: 4000,
                        isClosable: true,
                        position: "top",
                    });
                } else {
                    throw new Error(
                        result.error || "API returned unsuccessful response"
                    );
                }
            } else {
                let errorMessage = `HTTP ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch {
                    // If we can't parse error as JSON, use status message
                    errorMessage = `HTTP ${response.status} ${response.statusText}`;
                }
                throw new Error(errorMessage);
            }
        } catch (error) {
            console.error("Error logging event:", error);

            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Please check your connection and try again.";

            toast({
                title: "Error logging event",
                description: errorMessage,
                status: "error",
                duration: 5000,
                isClosable: true,
                position: "top",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    /** @param {React.KeyboardEvent<HTMLInputElement>} e */
    const handleKeyUp = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleClear = () => {
        setDescription("");
    };

    /** @param {string} dateString */
    const formatDate = (dateString) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) return "just now";
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString();
    };

    return (
        <Container maxW="100%" px={4} py={8}>
            <VStack spacing={8} align="stretch" justify="center" minH="70vh">
                {/* Header */}
                <Box textAlign="center">
                    <Heading size="xl" color="gray.800" fontWeight="400" mb={3}>
                        Log an Event
                    </Heading>
                    <Text color="gray.600" fontSize="lg">
                        What happened?
                    </Text>
                </Box>

                {/* Main Input Card */}
                <Card
                    shadow="lg"
                    borderRadius="2xl"
                    bg="white"
                    mx={2}
                    maxW="md"
                    alignSelf="center"
                    w="full"
                >
                    <CardBody p={6}>
                        <VStack spacing={4} align="stretch">
                            <Input
                                placeholder="Type your event description here..."
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                onKeyUp={handleKeyUp}
                                size="lg"
                                border="2px"
                                borderColor="gray.200"
                                focusBorderColor="blue.400"
                                bg="gray.50"
                                fontSize="lg"
                                py={6}
                                ref={inputRef}
                                _placeholder={{
                                    color: "gray.500",
                                    fontSize: "lg",
                                }}
                                _focus={{
                                    bg: "white",
                                    shadow: "md",
                                    borderColor: "blue.500",
                                }}
                            />

                            <HStack spacing={3} justify="space-between">
                                <Text fontSize="sm" color="gray.500">
                                    Press Enter to log event
                                </Text>
                                <HStack spacing={2}>
                                    <Button
                                        variant="ghost"
                                        onClick={handleClear}
                                        isDisabled={
                                            !description.trim() || isSubmitting
                                        }
                                        size="md"
                                        color="gray.600"
                                    >
                                        Clear
                                    </Button>
                                    <Button
                                        colorScheme="blue"
                                        onClick={handleSubmit}
                                        isLoading={isSubmitting}
                                        loadingText="Logging..."
                                        isDisabled={!description.trim()}
                                        size="md"
                                        px={8}
                                        borderRadius="xl"
                                    >
                                        Log Event
                                    </Button>
                                </HStack>
                            </HStack>
                        </VStack>
                    </CardBody>
                </Card>

                {/* Recent Entries Section */}
                {!isLoadingEntries && recentEntries.length > 0 && (
                    <Card
                        shadow="md"
                        borderRadius="xl"
                        bg="gray.50"
                        mx={2}
                        maxW="md"
                        alignSelf="center"
                        w="full"
                    >
                        <CardBody p={4}>
                            <VStack spacing={3} align="stretch">
                                <Text
                                    fontSize="sm"
                                    fontWeight="semibold"
                                    color="gray.600"
                                    textAlign="center"
                                >
                                    Recent Events
                                </Text>
                                <Divider />
                                {recentEntries.map((entry, index) => (
                                    <Box
                                        key={entry.id || index}
                                        p={3}
                                        bg="white"
                                        borderRadius="lg"
                                        shadow="sm"
                                    >
                                        <HStack
                                            justify="space-between"
                                            align="flex-start"
                                        >
                                            <VStack
                                                align="flex-start"
                                                spacing={1}
                                                flex={1}
                                            >
                                                <HStack spacing={2}>
                                                    <Badge
                                                        colorScheme="blue"
                                                        variant="subtle"
                                                        fontSize="xs"
                                                    >
                                                        {entry.type}
                                                    </Badge>
                                                    <Text
                                                        fontSize="xs"
                                                        color="gray.500"
                                                    >
                                                        {formatDate(entry.date)}
                                                    </Text>
                                                </HStack>
                                                <Text
                                                    fontSize="sm"
                                                    color="gray.700"
                                                >
                                                    {entry.description}
                                                </Text>
                                            </VStack>
                                        </HStack>
                                    </Box>
                                ))}
                            </VStack>
                        </CardBody>
                    </Card>
                )}

                {/* Loading state for recent entries */}
                {isLoadingEntries && (
                    <Card
                        shadow="md"
                        borderRadius="xl"
                        bg="gray.50"
                        mx={2}
                        maxW="md"
                        alignSelf="center"
                        w="full"
                    >
                        <CardBody p={4}>
                            <VStack spacing={3} align="stretch">
                                <Text
                                    fontSize="sm"
                                    fontWeight="semibold"
                                    color="gray.600"
                                    textAlign="center"
                                >
                                    Recent Events
                                </Text>
                                <Divider />
                                {[...Array(3)].map((_, i) => (
                                    <Box
                                        key={i}
                                        p={3}
                                        bg="white"
                                        borderRadius="lg"
                                        shadow="sm"
                                    >
                                        <VStack align="flex-start" spacing={2}>
                                            <HStack spacing={2}>
                                                <Skeleton
                                                    height="16px"
                                                    width="60px"
                                                />
                                                <Skeleton
                                                    height="14px"
                                                    width="50px"
                                                />
                                            </HStack>
                                            <Skeleton
                                                height="16px"
                                                width="100%"
                                            />
                                        </VStack>
                                    </Box>
                                ))}
                            </VStack>
                        </CardBody>
                    </Card>
                )}

                {/* Navigation */}
                <Box textAlign="center" pt={6} pb={4}>
                    <Link to="/">
                        <Button
                            variant="ghost"
                            size="lg"
                            color="gray.600"
                            borderRadius="xl"
                            px={6}
                        >
                            ← Back to Home
                        </Button>
                    </Link>
                </Box>
            </VStack>
        </Container>
    );
}
