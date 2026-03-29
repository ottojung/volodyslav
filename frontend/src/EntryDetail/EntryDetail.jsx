import React, { useState, useEffect } from "react";
import { useParams, useLocation, useNavigate, Link } from "react-router-dom";
import { Container, VStack, Card, HStack, Text, Spinner, Box, Badge, Button } from "@chakra-ui/react";
import { fetchEntryById, deleteEntryById, fetchAdditionalProperties, fetchEntryAssets } from "../Search/api.js";
import { getEntryParsed } from "../DescriptionEntry/entry.js";
import { formatRelativeDate } from "../DescriptionEntry/utils.js";
import {
    SPACING,
    SIZES,
    CARD_STYLES,
    TEXT_STYLES,
} from "../DescriptionEntry/styles.js";
import { FieldRow, entryToFields } from "./EntryDetailFieldRow.jsx";
import { EntryDetailMediaCard, filterAssetsByType, mergeAdditionalProperties, hasAdditionalPropertyValue } from "./EntryDetailMediaCard.jsx";

/**
 * @typedef {import('../DescriptionEntry/entry.js').Entry} Entry
 */

/**
 * @typedef {import('../Search/api.js').AdditionalPropertyName} AdditionalPropertyName
 */

/** @type {AdditionalPropertyName[]} */
const ADDITIONAL_PROPERTY_NAMES = ["calories", "transcription", "basic_context"];

/**
 * Entry detail page. Displays all JSON fields for a single entry
 * with copy buttons on the right of each field.
 * @returns {React.JSX.Element}
 */
export default function EntryDetail() {
    const { id } = useParams();
    const location = useLocation();
    const navigate = useNavigate();

    /** @type {Entry|null} */
    const stateEntry = location.state?.entry ?? null;

    const [entry, setEntry] = useState(stateEntry);
    const [isLoading, setIsLoading] = useState(stateEntry === null);
    const [notFound, setNotFound] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showDerivedFields, setShowDerivedFields] = useState(false);

    /** @type {[import('../Search/api.js').AdditionalProperties | null, Function]} */
    const [additionalProperties, setAdditionalProperties] = useState({});

    /** @type {[AdditionalPropertyName[], Function]} */
    const [loadingAdditionalProperties, setLoadingAdditionalProperties] = useState(ADDITIONAL_PROPERTY_NAMES);

    /** @type {[{filename: string, url: string, mediaType: 'image'|'audio'|'other'}[] | null, Function]} */
    const [entryAssets, setEntryAssets] = useState(null);

    useEffect(() => {
        if (stateEntry !== null || id === undefined) return undefined;

        let isActive = true;

        setIsLoading(true);
        fetchEntryById(id).then((fetched) => {
            if (!isActive) return;
            if (fetched === null) {
                setNotFound(true);
            } else {
                setEntry(fetched);
            }
            setIsLoading(false);
        });

        return () => {
            isActive = false;
        };
    }, [id, stateEntry]);

    useEffect(() => {
        if (id === undefined) return undefined;

        let isActive = true;

        setAdditionalProperties({});
        setLoadingAdditionalProperties(ADDITIONAL_PROPERTY_NAMES);

        for (const propertyName of ADDITIONAL_PROPERTY_NAMES) {
            fetchAdditionalProperties(id, propertyName).then((props) => {
                if (!isActive) return;
                setAdditionalProperties(
                    /** @param {import('../Search/api.js').AdditionalProperties} currentProperties */
                    (currentProperties) => mergeAdditionalProperties(currentProperties, props),
                );
                setLoadingAdditionalProperties(
                    /** @param {AdditionalPropertyName[]} currentProperties */
                    (currentProperties) => currentProperties.filter(
                        /** @param {AdditionalPropertyName} currentProperty */
                        (currentProperty) => currentProperty !== propertyName,
                    ),
                );
            });
        }
        return () => {
            isActive = false;
        };
    }, [id]);

    useEffect(() => {
        if (id === undefined) return undefined;

        let isActive = true;

        setEntryAssets(null);
        fetchEntryAssets(id).then((assets) => {
            if (!isActive) return;
            setEntryAssets(assets);
        });

        return () => {
            isActive = false;
        };
    }, [id]);

    useEffect(() => {
        setShowDerivedFields(false);
    }, [entry]);

    async function handleDelete() {
        if (entry === null) return;
        setIsDeleting(true);
        const success = await deleteEntryById(entry.id);
        if (success) {
            navigate("/search");
        } else {
            setIsDeleting(false);
        }
    }

    if (isLoading) {
        return (
            <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
                <Box textAlign="center" py={SPACING.xxl}>
                    <Spinner size="md" color="blue.400" aria-label="Loading entry" />
                </Box>
            </Container>
        );
    }

    if (notFound || entry === null) {
        return (
            <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
                <Card.Root {...CARD_STYLES.secondary}>
                    <Card.Body p={SPACING.lg}>
                        <Text {...TEXT_STYLES.helper} textAlign="center">Entry not found.</Text>
                    </Card.Body>
                </Card.Root>
            </Container>
        );
    }

    const { primaryFields, derivedFields } = entryToFields(entry);
    const { type: entryType } = getEntryParsed(entry);

    const additionalFields = Object.entries(additionalProperties).filter(([key, value]) => key !== "errors" && key !== "basic_context" && hasAdditionalPropertyValue(value));

    const allErrors = additionalProperties.errors ?? {};
    const basicContextError = allErrors["basic_context"] ?? null;
    const additionalPropertyErrors = Object.fromEntries(
        Object.entries(allErrors).filter(([key]) => key !== "basic_context")
    );

    const basicContextItems = additionalProperties.basic_context;
    const isLoadingBasicContext = loadingAdditionalProperties.includes("basic_context");
    const loadingComputedProperties = loadingAdditionalProperties.filter((name) => name !== "basic_context");

    const imageAssets = filterAssetsByType(entryAssets, "image");
    const audioAssets = filterAssetsByType(entryAssets, "audio");
    const otherAssets = filterAssetsByType(entryAssets, "other");

    return (
        <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
            <VStack gap={SPACING.xxl} align="stretch" justify="flex-start">
                <Card.Root {...CARD_STYLES.main}>
                    <Card.Body p={SPACING.lg}>
                        <HStack gap={2} mb={SPACING.md} justify="space-between">
                            <Badge colorPalette="blue" variant="subtle">{entryType}</Badge>
                            <Button
                                colorPalette="red"
                                size="sm"
                                variant="outline"
                                onClick={handleDelete}
                                loading={isDeleting}
                                loadingText="Deleting..."
                            >
                                Delete
                            </Button>
                        </HStack>
                        <VStack gap={SPACING.sm} align="stretch">
                            {primaryFields.map((field) => (
                                <FieldRow key={field.key} fieldKey={field.key} value={field.value} />
                            ))}
                            {derivedFields.length > 0 && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    justifyContent="flex-start"
                                    alignSelf="flex-start"
                                    onClick={() => setShowDerivedFields((currentValue) => !currentValue)}
                                    aria-expanded={showDerivedFields}
                                >
                                    {showDerivedFields ? "Hide derived" : "Show derived"}
                                </Button>
                            )}
                            {showDerivedFields && derivedFields.map((field) => (
                                <FieldRow key={field.key} fieldKey={field.key} value={field.value} />
                            ))}
                        </VStack>
                    </Card.Body>
                </Card.Root>

                <EntryDetailMediaCard
                    imageAssets={imageAssets}
                    audioAssets={audioAssets}
                    otherAssets={otherAssets}
                />

                <Card.Root {...CARD_STYLES.secondary}>
                    <Card.Body p={SPACING.lg}>
                        <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase" mb={SPACING.sm}>
                            Computed Properties
                        </Text>
                        {additionalFields.length > 0 && (
                            <VStack gap={SPACING.sm} align="stretch" mb={loadingComputedProperties.length > 0 ? SPACING.md : 0}>
                                {additionalFields.map(([key, value]) => (
                                    <FieldRow key={key} fieldKey={key} value={String(value)} />
                                ))}
                            </VStack>
                        )}
                        {loadingComputedProperties.length > 0 ? (
                            <Box py={SPACING.md}>
                                <VStack align="stretch" gap={SPACING.xs}>
                                    {loadingComputedProperties.map((propertyName) => (
                                        <HStack key={propertyName} align="flex-start" gap={SPACING.sm}>
                                            <Spinner
                                                size="sm"
                                                color="blue.400"
                                                mt="2px"
                                                data-testid={`computed-property-spinner-${propertyName}`}
                                            />
                                            <Text {...TEXT_STYLES.helper}>
                                                Loading {propertyName}...
                                            </Text>
                                        </HStack>
                                    ))}
                                </VStack>
                            </Box>
                        ) : additionalFields.length === 0 && Object.keys(additionalPropertyErrors).length === 0 ? (
                            <Text {...TEXT_STYLES.helper}>None</Text>
                        ) : null}
                        {Object.keys(additionalPropertyErrors).length > 0 && loadingComputedProperties.length === 0 && (
                            <VStack gap={SPACING.sm} align="stretch" mt={additionalFields.length > 0 ? SPACING.sm : 0}>
                                {Object.entries(additionalPropertyErrors).map(([key, message]) => (
                                    <Box key={key} px={SPACING.sm} py={SPACING.xs} borderRadius="md" bg="red.50" borderWidth="1px" borderColor="red.200">
                                        <Text fontSize="xs" fontWeight="semibold" color="red.600" textTransform="uppercase" mb={1}>
                                            {key} error
                                        </Text>
                                        <Text fontSize="sm" color="red.700">{message}</Text>
                                    </Box>
                                ))}
                            </VStack>
                        )}
                    </Card.Body>
                </Card.Root>

                <Card.Root {...CARD_STYLES.secondary}>
                    <Card.Body p={SPACING.lg}>
                        <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase" mb={SPACING.sm}>
                            Basic Context
                        </Text>
                        {isLoadingBasicContext ? (
                            <Box py={SPACING.md}>
                                <HStack align="flex-start" gap={SPACING.sm}>
                                    <Spinner size="sm" color="blue.400" mt="2px" />
                                    <Text {...TEXT_STYLES.helper}>Loading basic context...</Text>
                                </HStack>
                            </Box>
                        ) : basicContextError !== null ? (
                            <Box px={SPACING.sm} py={SPACING.xs} borderRadius="md" bg="red.50" borderWidth="1px" borderColor="red.200">
                                <Text fontSize="xs" fontWeight="semibold" color="red.600" textTransform="uppercase" mb={1}>
                                    basic context error
                                </Text>
                                <Text fontSize="sm" color="red.700">{basicContextError}</Text>
                            </Box>
                        ) : !basicContextItems || basicContextItems.length === 0 ? (
                            <Text {...TEXT_STYLES.helper}>None</Text>
                        ) : (
                            <VStack gap={SPACING.sm} align="stretch">
                                {basicContextItems.map((item) => {
                                    const { type: itemType, description: itemDescription } = getEntryParsed({ input: item.input });
                                    return (
                                        <Link
                                            key={item.id}
                                            to={`/entry/${item.id}`}
                                            style={{ textDecoration: "none", color: "inherit", display: "block" }}
                                        >
                                            <Box
                                                {...CARD_STYLES.entry}
                                                cursor="pointer"
                                                _hover={{ bg: "gray.100" }}
                                            >
                                                <HStack justify="space-between" align="flex-start">
                                                    <VStack align="flex-start" gap={1} flex={1}>
                                                        <HStack gap={2}>
                                                            <Badge colorPalette="blue" variant="subtle">{itemType}</Badge>
                                                            <Text {...TEXT_STYLES.entryMeta}>
                                                                {formatRelativeDate(item.date)}
                                                            </Text>
                                                        </HStack>
                                                        <Text {...TEXT_STYLES.entryText}>{itemDescription}</Text>
                                                    </VStack>
                                                </HStack>
                                            </Box>
                                        </Link>
                                    );
                                })}
                            </VStack>
                        )}
                    </Card.Body>
                </Card.Root>
            </VStack>
        </Container>
    );
}
