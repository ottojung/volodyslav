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
} from "@chakra-ui/react";
import { Link } from "react-router-dom";

export default function DescriptionEntry() {
    const [description, setDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const toast = useToast();

    // Ref for the input field
    const inputRef = useRef(null);

    useEffect(() => {
        if (inputRef.current) {
            // @ts-expect-error: inputRef is not typed, but focus() is valid for Chakra Input
            inputRef.current.focus();
        }
    }, []);

    // For now, use the same default as the Python script
    const API_BASE_URL = "/api";

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
