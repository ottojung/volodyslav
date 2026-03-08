import React, { useState, useEffect } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import {
    Container,
    VStack,
    Card,
    CardBody,
    HStack,
    Text,
    IconButton,
    Tooltip,
    Spinner,
    Box,
    Badge,
    Button,
    SimpleGrid,
    Image,
    Link,
} from "@chakra-ui/react";
import { fetchEntryById, deleteEntryById, fetchAdditionalProperties, fetchEntryAssets } from "../Search/api.js";
import { API_BASE_URL } from "../api_base_url.js";
import {
    SPACING,
    SIZES,
    CARD_STYLES,
    TEXT_STYLES,
    BADGE_STYLES,
} from "../DescriptionEntry/styles.js";

/**
 * @typedef {import('../DescriptionEntry/entry.js').Entry} Entry
 */

/**
 * @typedef {import('../Search/api.js').AdditionalPropertyName} AdditionalPropertyName
 */

const COLLAPSED_FIELD_VALUE_LENGTH = 100;

/**
 * Flattens an entry into a list of key-value pairs for display.
 * @param {Entry} entry
 * @returns {Array<{key: string, value: string}>}
 */
function entryToFields(entry) {
    const fields = [
        { key: "id", value: entry.id },
        { key: "date", value: entry.date },
        { key: "type", value: entry.type },
        { key: "description", value: entry.description },
        { key: "input", value: entry.input },
        { key: "original", value: entry.original },
    ];

    for (const [k, v] of Object.entries(entry.modifiers)) {
        fields.push({ key: `modifiers.${k}`, value: v });
    }

    return fields;
}

/**
 * A single field row with a copy button.
 * @param {{ fieldKey: string, value: string }} props
 * @returns {JSX.Element}
 */
function FieldRow({ fieldKey, value }) {
    const [copied, setCopied] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const isCollapsible = value.length > COLLAPSED_FIELD_VALUE_LENGTH;
    const displayedValue = !isCollapsible || isExpanded
        ? value
        : `${value.slice(0, COLLAPSED_FIELD_VALUE_LENGTH)}…`;

    async function handleCopy() {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <Box {...CARD_STYLES.entry}>
            <HStack justify="space-between" align="flex-start">
                <VStack align="flex-start" spacing={1} flex={1} minW={0}>
                    <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase">
                        {fieldKey}
                    </Text>
                    <Text {...TEXT_STYLES.entryText} wordBreak="break-all">{displayedValue}</Text>
                    {isCollapsible && (
                        <Button
                            size="xs"
                            variant="link"
                            colorScheme="blue"
                            onClick={() => setIsExpanded((currentValue) => !currentValue)}
                            aria-label={`${isExpanded ? "Show less" : "Show full"} ${fieldKey}`}
                        >
                            {isExpanded ? "Show less" : "Show more"}
                        </Button>
                    )}
                </VStack>
                <Tooltip label={copied ? "Copied!" : "Copy"} placement="left">
                    <IconButton
                        aria-label={`Copy ${fieldKey}`}
                        size="sm"
                        variant="ghost"
                        onClick={handleCopy}
                        icon={<span>{copied ? "✓" : "⎘"}</span>}
                        flexShrink={0}
                    />
                </Tooltip>
            </HStack>
        </Box>
    );
}

/**
 * Filters assets by media type.
 * @param {import('../Search/api.js').AssetInfo[] | null} assets
 * @param {import('../Search/api.js').MediaType} mediaType
 * @returns {import('../Search/api.js').AssetInfo[] | null}
 */
function filterAssetsByType(assets, mediaType) {
    if (assets === null) return null;
    return assets.filter((a) => a.mediaType === mediaType);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasAdditionalPropertyValue(value) {
    return value !== undefined && value !== null;
}

/** @type {AdditionalPropertyName[]} */
const ADDITIONAL_PROPERTY_NAMES = ["calories", "transcription"];

/**
 * Entry detail page. Displays all JSON fields for a single entry
 * with copy buttons on the right of each field.
 * @returns {JSX.Element}
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
                    (currentProperties) => ({
                    ...currentProperties,
                    ...props,
                    }),
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
                    <Spinner size="md" color="blue.400" />
                </Box>
            </Container>
        );
    }

    if (notFound || entry === null) {
        return (
            <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
                <Card {...CARD_STYLES.secondary}>
                    <CardBody p={SPACING.lg}>
                        <Text {...TEXT_STYLES.helper} textAlign="center">Entry not found.</Text>
                    </CardBody>
                </Card>
            </Container>
        );
    }

    const fields = entryToFields(entry);

    const additionalFields = Object.entries(additionalProperties).filter(([, value]) => hasAdditionalPropertyValue(value));

    const imageAssets = filterAssetsByType(entryAssets, "image");
    const audioAssets = filterAssetsByType(entryAssets, "audio");
    const otherAssets = filterAssetsByType(entryAssets, "other");

    return (
        <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
            <VStack spacing={SPACING.xxl} align="stretch" justify="flex-start">
                <Card {...CARD_STYLES.main}>
                    <CardBody p={SPACING.lg}>
                        <HStack spacing={2} mb={SPACING.md} justify="space-between">
                            <Badge {...BADGE_STYLES}>{entry.type}</Badge>
                            <Button
                                colorScheme="red"
                                size="sm"
                                variant="outline"
                                onClick={handleDelete}
                                isLoading={isDeleting}
                                loadingText="Deleting..."
                            >
                                Delete
                            </Button>
                        </HStack>
                        <VStack spacing={SPACING.sm} align="stretch">
                            {fields.map((field) => (
                                <FieldRow key={field.key} fieldKey={field.key} value={field.value} />
                            ))}
                        </VStack>
                    </CardBody>
                </Card>

                <Card {...CARD_STYLES.secondary}>
                    <CardBody p={SPACING.lg}>
                        <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase" mb={SPACING.sm}>
                            Additional Properties
                        </Text>
                        {additionalFields.length > 0 && (
                            <VStack spacing={SPACING.sm} align="stretch" mb={loadingAdditionalProperties.length > 0 ? SPACING.md : 0}>
                                {additionalFields.map(([key, value]) => (
                                    <FieldRow key={key} fieldKey={key} value={String(value)} />
                                ))}
                            </VStack>
                        )}
                        {loadingAdditionalProperties.length > 0 ? (
                            <Box py={SPACING.md}>
                                <HStack align="flex-start" spacing={SPACING.sm}>
                                    <Spinner size="sm" color="blue.400" mt="2px" />
                                    <VStack align="flex-start" spacing={1}>
                                        {loadingAdditionalProperties.map((propertyName) => (
                                            <Text key={propertyName} {...TEXT_STYLES.helper}>
                                                Loading {propertyName}...
                                            </Text>
                                        ))}
                                    </VStack>
                                </HStack>
                            </Box>
                        ) : additionalFields.length === 0 ? (
                            <Text {...TEXT_STYLES.helper}>None</Text>
                        ) : null}
                    </CardBody>
                </Card>

                <Card {...CARD_STYLES.secondary}>
                    <CardBody p={SPACING.lg}>
                        <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase" mb={SPACING.sm}>
                            Media
                        </Text>
                        {imageAssets === null || audioAssets === null || otherAssets === null ? (
                            <Box textAlign="center" py={SPACING.md}>
                                <Spinner size="sm" color="blue.400" />
                            </Box>
                        ) : imageAssets.length === 0 && audioAssets.length === 0 && otherAssets.length === 0 ? (
                            <Text {...TEXT_STYLES.helper}>None</Text>
                        ) : (
                            <VStack spacing={SPACING.md} align="stretch">
                                {imageAssets.length > 0 && (
                                    <Box>
                                        <Text fontSize="xs" color="gray.400" mb={SPACING.sm}>Photos</Text>
                                        <SimpleGrid columns={[2, 3, 4]} spacing={SPACING.sm}>
                                            {imageAssets.map((asset) => (
                                                <Link
                                                    key={asset.filename}
                                                    href={`${API_BASE_URL}${asset.url}`}
                                                    isExternal
                                                >
                                                    <Image
                                                        src={`${API_BASE_URL}${asset.url}`}
                                                        alt={asset.filename}
                                                        objectFit="cover"
                                                        borderRadius="md"
                                                        w="100%"
                                                        h="120px"
                                                    />
                                                </Link>
                                            ))}
                                        </SimpleGrid>
                                    </Box>
                                )}
                                {audioAssets.length > 0 && (
                                    <Box>
                                        <Text fontSize="xs" color="gray.400" mb={SPACING.sm}>Audio</Text>
                                        <VStack spacing={SPACING.sm} align="stretch">
                                            {audioAssets.map((asset) => (
                                                <Box key={asset.filename}>
                                                    <Text fontSize="xs" color="gray.500" mb={1}>{asset.filename}</Text>
                                                    <Box as="audio" controls w="100%" src={`${API_BASE_URL}${asset.url}`} />
                                                </Box>
                                            ))}
                                        </VStack>
                                    </Box>
                                )}
                                {otherAssets.length > 0 && (
                                    <Box>
                                        <Text fontSize="xs" color="gray.400" mb={SPACING.sm}>Other files</Text>
                                        <VStack spacing={SPACING.sm} align="stretch">
                                            {otherAssets.map((asset) => (
                                                <Link
                                                    key={asset.filename}
                                                    href={`${API_BASE_URL}${asset.url}`}
                                                    isExternal
                                                >
                                                    <Text fontSize="sm">{asset.filename}</Text>
                                                </Link>
                                            ))}
                                        </VStack>
                                    </Box>
                                )}
                            </VStack>
                        )}
                    </CardBody>
                </Card>
            </VStack>
        </Container>
    );
}
