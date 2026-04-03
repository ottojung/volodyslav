import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
    Button,
    Card,
    Container,
    Heading,
    HStack,
    Spinner,
    Text,
    VStack,
} from "@chakra-ui/react";
import { useToast } from "../toast.jsx";
import { fetchOntology, updateOntology } from "../DescriptionEntry/api.js";
import { TypeRow } from "./TypeRow.jsx";
import { ModifierRow } from "./ModifierRow.jsx";

/**
 * @typedef {import('../DescriptionEntry/api.js').OntologyTypeEntry} OntologyTypeEntry
 * @typedef {import('../DescriptionEntry/api.js').OntologyModifierEntry} OntologyModifierEntry
 */

/**
 * @typedef {object} KeyedTypeEntry
 * @property {number} key - Stable unique key for React rendering
 * @property {OntologyTypeEntry} entry - The type entry
 */

/**
 * @typedef {object} KeyedModifierEntry
 * @property {number} key - Stable unique key for React rendering
 * @property {OntologyModifierEntry} entry - The modifier entry
 */

/**
 * Page for managing the ontology (entry types and modifiers).
 * @returns {React.JSX.Element}
 */
export default function OntologyPage() {
    /** @type {[KeyedTypeEntry[], React.Dispatch<React.SetStateAction<KeyedTypeEntry[]>>]} */
    const [keyedTypes, setKeyedTypes] = useState([]);
    /** @type {[KeyedModifierEntry[], React.Dispatch<React.SetStateAction<KeyedModifierEntry[]>>]} */
    const [keyedModifiers, setKeyedModifiers] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const nextKey = useRef(0);
    const toast = useToast();

    function nextUniqueKey() {
        const key = nextKey.current;
        nextKey.current += 1;
        return key;
    }

    useEffect(() => {
        const load = async () => {
            setIsLoading(true);
            const ontology = await fetchOntology();
            if (ontology) {
                let keyCounter = 0;
                setKeyedTypes(ontology.types.map((entry) => {
                    const k = keyCounter;
                    keyCounter += 1;
                    return { key: k, entry };
                }));
                setKeyedModifiers(ontology.modifiers.map((entry) => {
                    const k = keyCounter;
                    keyCounter += 1;
                    return { key: k, entry };
                }));
                nextKey.current = keyCounter;
            } else {
                setKeyedTypes([]);
                setKeyedModifiers([]);
            }
            setIsLoading(false);
        };
        load();
    }, []);

    /**
     * @param {number} rowKey
     * @param {OntologyTypeEntry} updated
     */
    function handleTypeChange(rowKey, updated) {
        setKeyedTypes((prev) =>
            prev.map((kt) => kt.key === rowKey ? { key: kt.key, entry: updated } : kt)
        );
    }

    /** @param {number} rowKey */
    function handleTypeDelete(rowKey) {
        setKeyedTypes((prev) => prev.filter((kt) => kt.key !== rowKey));
    }

    function handleAddType() {
        /** @type {OntologyTypeEntry} */
        const empty = { name: "", description: "" };
        setKeyedTypes((prev) => [...prev, { key: nextUniqueKey(), entry: empty }]);
    }

    /**
     * @param {number} rowKey
     * @param {OntologyModifierEntry} updated
     */
    function handleModifierChange(rowKey, updated) {
        setKeyedModifiers((prev) =>
            prev.map((km) => km.key === rowKey ? { key: km.key, entry: updated } : km)
        );
    }

    /** @param {number} rowKey */
    function handleModifierDelete(rowKey) {
        setKeyedModifiers((prev) => prev.filter((km) => km.key !== rowKey));
    }

    function handleAddModifier() {
        /** @type {OntologyModifierEntry} */
        const empty = { name: "", description: "" };
        setKeyedModifiers((prev) => [...prev, { key: nextUniqueKey(), entry: empty }]);
    }

    async function handleSave() {
        setIsSaving(true);
        const result = await updateOntology({
            types: keyedTypes.map((kt) => kt.entry),
            modifiers: keyedModifiers.map((km) => km.entry),
        });
        setIsSaving(false);

        if (result !== null) {
            toast({
                title: "Ontology saved.",
                status: "success",
                duration: 3000,
                isClosable: true,
            });
        } else {
            toast({
                title: "Failed to save ontology.",
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
                <VStack gap={4} align="center">
                    <Spinner size="xl" />
                    <Text>Loading ontology...</Text>
                </VStack>
            </Container>
        );
    }

    return (
        <Container maxW="2xl" py={6}>
            <VStack gap={6} align="stretch">
                <HStack justify="space-between">
                    <Heading size="lg">Ontology</Heading>
                    <Link to="/">
                        <Button variant="ghost" size="sm">← Back</Button>
                    </Link>
                </HStack>

                <Text fontSize="sm" color="gray.600">
                    Define the meaning of entry types and modifiers to help AI understand your log entries.
                </Text>

                <Card.Root shadow="md" borderRadius="xl">
                    <Card.Body>
                        <VStack gap={4} align="stretch">
                            <Heading size="sm">Entry Types</Heading>

                            {keyedTypes.length === 0 && (
                                <Text fontSize="sm" color="gray.500" textAlign="center" py={4}>
                                    No types yet. Click &ldquo;Add Type&rdquo; to define one.
                                </Text>
                            )}

                            {keyedTypes.map(({ key, entry }) => (
                                <TypeRow
                                    key={key}
                                    rowKey={key}
                                    entry={entry}
                                    onChange={handleTypeChange}
                                    onDelete={handleTypeDelete}
                                />
                            ))}

                            <Button
                                size="sm"
                                colorPalette="blue"
                                onClick={handleAddType}
                                alignSelf="flex-start"
                            >
                                + Add Type
                            </Button>
                        </VStack>
                    </Card.Body>
                </Card.Root>

                <Card.Root shadow="md" borderRadius="xl">
                    <Card.Body>
                        <VStack gap={4} align="stretch">
                            <Heading size="sm">Modifiers</Heading>

                            {keyedModifiers.length === 0 && (
                                <Text fontSize="sm" color="gray.500" textAlign="center" py={4}>
                                    No modifiers yet. Click &ldquo;Add Modifier&rdquo; to define one.
                                </Text>
                            )}

                            {keyedModifiers.map(({ key, entry }) => (
                                <ModifierRow
                                    key={key}
                                    rowKey={key}
                                    entry={entry}
                                    onChange={handleModifierChange}
                                    onDelete={handleModifierDelete}
                                />
                            ))}

                            <Button
                                size="sm"
                                colorPalette="blue"
                                onClick={handleAddModifier}
                                alignSelf="flex-start"
                            >
                                + Add Modifier
                            </Button>
                        </VStack>
                    </Card.Body>
                </Card.Root>

                <Button
                    colorPalette="blue"
                    size="lg"
                    onClick={handleSave}
                    loading={isSaving}
                    loadingText="Saving..."
                >
                    Save Ontology
                </Button>
            </VStack>
        </Container>
    );
}
