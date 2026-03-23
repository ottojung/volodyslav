import React from "react";
import {
    Card,
    CardBody,
    VStack,
    Text,
    Spinner,
    Box,
    SimpleGrid,
    Image,
    Link,
} from "@chakra-ui/react";
import { API_BASE_URL } from "../api_base_url.js";
import {
    SPACING,
    CARD_STYLES,
    TEXT_STYLES,
} from "../DescriptionEntry/styles.js";

/**
 * @typedef {import('../Search/api.js').AssetInfo} AssetInfo
 * @typedef {import('../Search/api.js').MediaType} MediaType
 */

/**
 * Filters assets by media type.
 * @param {AssetInfo[] | null} assets
 * @param {MediaType} mediaType
 * @returns {AssetInfo[] | null}
 */
export function filterAssetsByType(assets, mediaType) {
    if (assets === null) return null;
    return assets.filter((a) => a.mediaType === mediaType);
}

/**
 * Merges two AdditionalProperties objects, deeply merging the `errors` sub-object.
 * @param {import('../Search/api.js').AdditionalProperties} current
 * @param {import('../Search/api.js').AdditionalProperties} incoming
 * @returns {import('../Search/api.js').AdditionalProperties}
 */
export function mergeAdditionalProperties(current, incoming) {
    const mergedErrors = {
        ...(current.errors ?? {}),
        ...(incoming.errors ?? {}),
    };
    /** @type {import('../Search/api.js').AdditionalProperties} */
    const merged = { ...current, ...incoming };
    if (Object.keys(mergedErrors).length > 0) {
        merged.errors = mergedErrors;
    } else {
        delete merged.errors;
    }
    return merged;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasAdditionalPropertyValue(value) {
    return value !== undefined && value !== null;
}

/**
 * Card showing the media assets (images, audio, other) for an entry.
 * @param {{ imageAssets: AssetInfo[] | null, audioAssets: AssetInfo[] | null, otherAssets: AssetInfo[] | null }} props
 * @returns {React.JSX.Element}
 */
export function EntryDetailMediaCard({ imageAssets, audioAssets, otherAssets }) {
    return (
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
    );
}
