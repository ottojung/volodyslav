import React from "react";
import {
    Card,
    CardBody,
    FormControl,
    FormLabel,
    HStack,
    IconButton,
    Input,
    Text,
    VStack,
} from "@chakra-ui/react";

/**
 * @typedef {import('../DescriptionEntry/api.js').Shortcut} Shortcut
 */

/**
 * A single shortcut row in the editor.
 * @param {Object} props
 * @param {Shortcut} props.shortcut - The shortcut tuple [pattern, replacement, description?]
 * @param {number} props.rowKey - Stable key used for identification
 * @param {(rowKey: number, shortcut: Shortcut) => void} props.onChange - Called when any field changes
 * @param {(rowKey: number) => void} props.onDelete - Called when delete is clicked
 * @returns {JSX.Element}
 */
export function ShortcutRow({ shortcut, rowKey, onChange, onDelete }) {
    const [pattern, replacement, description] = shortcut;

    /**
     * @param {string} field
     * @param {string} value
     */
    function handleChange(field, value) {
        /** @type {Shortcut} */
        let updated;
        if (field === "pattern") {
            if (description !== undefined) {
                updated = [value, replacement, description];
            } else {
                updated = [value, replacement];
            }
        } else if (field === "replacement") {
            if (description !== undefined) {
                updated = [pattern, value, description];
            } else {
                updated = [pattern, value];
            }
        } else {
            if (value) {
                updated = [pattern, replacement, value];
            } else {
                updated = [pattern, replacement];
            }
        }
        onChange(rowKey, updated);
    }

    return (
        <Card variant="outline" size="sm" w="full">
            <CardBody>
                <VStack spacing={2} align="stretch">
                    <HStack spacing={2} align="flex-end">
                        <FormControl flex="1">
                            <FormLabel fontSize="xs" mb={1}>Pattern (regex)</FormLabel>
                            <Input
                                size="sm"
                                value={pattern}
                                onChange={(e) => handleChange("pattern", e.target.value)}
                                placeholder="e.g. breakfast"
                                fontFamily="mono"
                            />
                        </FormControl>
                        <FormControl flex="1">
                            <FormLabel fontSize="xs" mb={1}>Replacement</FormLabel>
                            <Input
                                size="sm"
                                value={replacement}
                                onChange={(e) => handleChange("replacement", e.target.value)}
                                placeholder="e.g. food [when this morning]"
                                fontFamily="mono"
                            />
                        </FormControl>
                        <IconButton
                            aria-label="Delete shortcut"
                            icon={<Text>✕</Text>}
                            size="sm"
                            colorScheme="red"
                            variant="ghost"
                            onClick={() => onDelete(rowKey)}
                        />
                    </HStack>
                    <FormControl>
                        <FormLabel fontSize="xs" mb={1}>Description (optional)</FormLabel>
                        <Input
                            size="sm"
                            value={description || ""}
                            onChange={(e) => handleChange("description", e.target.value)}
                            placeholder="What does this shortcut do?"
                        />
                    </FormControl>
                </VStack>
            </CardBody>
        </Card>
    );
}
