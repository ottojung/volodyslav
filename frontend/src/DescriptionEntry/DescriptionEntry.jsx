import React, { useState } from "react";
import {
    Box,
    VStack,
    Heading,
    Textarea,
    Button,
    Text,
    useToast,
    Fade,
    Card,
    CardBody,
    Container,
} from "@chakra-ui/react";
import { Link } from "react-router-dom";

/**
 * @typedef {Object} DescriptionEntry
 * @property {number} id
 * @property {string} description
 * @property {string} timestamp
 */

export default function DescriptionEntry() {
    const [description, setDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    /** @type {[DescriptionEntry[], React.Dispatch<React.SetStateAction<DescriptionEntry[]>>]} */
    const [savedEntries, setSavedEntries] = useState(
        /** @type {DescriptionEntry[]} */ ([])
    );
    const toast = useToast();

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
            // Simulate API call - replace with actual backend integration
            await new Promise((resolve) => setTimeout(resolve, 800));

            const newEntry = {
                id: Date.now(),
                description: description.trim(),
                timestamp: new Date().toLocaleString(),
            };

            setSavedEntries((prev) => [newEntry, ...prev]);
            setDescription("");

            toast({
                title: "Description saved",
                description: "Your description has been successfully saved.",
                status: "success",
                duration: 3000,
                isClosable: true,
                position: "top",
            });
        } catch (error) {
            toast({
                title: "Error saving description",
                description: "Please try again.",
                status: "error",
                duration: 3000,
                isClosable: true,
                position: "top",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleClear = () => {
        setDescription("");
    };

    return (
        <Container maxW="container.md" py={8}>
            <VStack spacing={8} align="stretch">
                {/* Header */}
                <Box textAlign="center">
                    <Heading size="lg" color="gray.700" fontWeight="300" mb={2}>
                        Describe Something
                    </Heading>
                    <Text color="gray.500" fontSize="sm">
                        Share your thoughts, observations, or ideas
                    </Text>
                </Box>

                {/* Main Input Card */}
                <Card shadow="sm" borderRadius="lg" bg="white">
                    <CardBody p={6}>
                        <VStack spacing={4} align="stretch">
                            <Textarea
                                placeholder="What would you like to describe? Share your thoughts here..."
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                minH="120px"
                                resize="vertical"
                                border="1px"
                                borderColor="gray.200"
                                focusBorderColor="blue.400"
                                bg="gray.50"
                                fontSize="md"
                                lineHeight="1.6"
                                _placeholder={{
                                    color: "gray.400",
                                    fontStyle: "italic",
                                }}
                                _focus={{
                                    bg: "white",
                                    shadow: "sm",
                                }}
                            />

                            <Box
                                display="flex"
                                gap={3}
                                justifyContent="flex-end"
                            >
                                <Button
                                    variant="ghost"
                                    onClick={handleClear}
                                    isDisabled={
                                        !description.trim() || isSubmitting
                                    }
                                    size="sm"
                                    color="gray.600"
                                >
                                    Clear
                                </Button>
                                <Button
                                    colorScheme="blue"
                                    onClick={handleSubmit}
                                    isLoading={isSubmitting}
                                    loadingText="Saving..."
                                    isDisabled={!description.trim()}
                                    size="sm"
                                    px={6}
                                >
                                    Save Description
                                </Button>
                            </Box>
                        </VStack>
                    </CardBody>
                </Card>

                {/* Recent Entries */}
                {savedEntries.length > 0 && (
                    <Box>
                        <Heading
                            size="md"
                            color="gray.600"
                            mb={4}
                            fontWeight="400"
                        >
                            Recent Descriptions
                        </Heading>
                        <VStack spacing={3} align="stretch">
                            {savedEntries.map((entry, index) => (
                                <Fade
                                    key={entry.id}
                                    in={true}
                                    transition={{
                                        enter: { delay: index * 0.1 },
                                    }}
                                >
                                    <Card
                                        size="sm"
                                        bg="gray.50"
                                        borderRadius="md"
                                    >
                                        <CardBody p={4}>
                                            <Text
                                                fontSize="sm"
                                                color="gray.700"
                                                lineHeight="1.5"
                                                mb={2}
                                            >
                                                {entry.description}
                                            </Text>
                                            <Text
                                                fontSize="xs"
                                                color="gray.500"
                                                textAlign="right"
                                            >
                                                {entry.timestamp}
                                            </Text>
                                        </CardBody>
                                    </Card>
                                </Fade>
                            ))}
                        </VStack>
                    </Box>
                )}

                {/* Navigation */}
                <Box textAlign="center" pt={4}>
                    <Link to="/">
                        <Button variant="ghost" size="sm" color="gray.500">
                            ← Back to Home
                        </Button>
                    </Link>
                </Box>
            </VStack>
        </Container>
    );
}
