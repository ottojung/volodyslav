import React, { useState } from "react";
import {
    Box,
    VStack,
    Heading,
    Input,
    Button,
    Text,
    useToast,
    Fade,
    Card,
    CardBody,
    Container,
    HStack,
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

    /** @param {React.KeyboardEvent<HTMLInputElement>} e */
    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleClear = () => {
        setDescription("");
    };

    return (
        <Container maxW="100%" px={4} py={6}>
            <VStack spacing={6} align="stretch" minH="100vh">
                {/* Header */}
                <Box textAlign="center" pt={4}>
                    <Heading size="xl" color="gray.800" fontWeight="400" mb={3}>
                        Describe Something
                    </Heading>
                    <Text color="gray.600" fontSize="lg">
                        What&apos;s on your mind?
                    </Text>
                </Box>

                {/* Main Input Card */}
                <Card shadow="lg" borderRadius="2xl" bg="white" mx={2}>
                    <CardBody p={6}>
                        <VStack spacing={4} align="stretch">
                            <Input
                                placeholder="Type your description here..."
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                onKeyPress={handleKeyPress}
                                size="lg"
                                border="2px"
                                borderColor="gray.200"
                                focusBorderColor="blue.400"
                                bg="gray.50"
                                fontSize="lg"
                                py={6}
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
                                    Press Enter to save
                                </Text>
                                <HStack spacing={2}>
                                    <Button
                                        variant="ghost"
                                        onClick={handleClear}
                                        isDisabled={!description.trim() || isSubmitting}
                                        size="md"
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
                                        size="md"
                                        px={8}
                                        borderRadius="xl"
                                    >
                                        Save
                                    </Button>
                                </HStack>
                            </HStack>
                        </VStack>
                    </CardBody>
                </Card>

                {/* Recent Entries */}
                {savedEntries.length > 0 && (
                    <Box px={2}>
                        <Heading
                            size="lg"
                            color="gray.700"
                            mb={4}
                            fontWeight="500"
                            textAlign="center"
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
                                        bg="gray.50"
                                        borderRadius="xl"
                                        shadow="sm"
                                        border="1px"
                                        borderColor="gray.100"
                                    >
                                        <CardBody p={5}>
                                            <Text
                                                fontSize="md"
                                                color="gray.800"
                                                lineHeight="1.6"
                                                mb={3}
                                                fontWeight="400"
                                            >
                                                {entry.description}
                                            </Text>
                                            <Text
                                                fontSize="sm"
                                                color="gray.500"
                                                textAlign="right"
                                                fontWeight="300"
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
