import React, { useState } from "react";
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
                        Describe Something
                    </Heading>
                    <Text color="gray.600" fontSize="lg">
                        What&apos;s on your mind?
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
