import React from "react";
import { Card, HStack, IconButton, Input, Text, VStack, Field } from "@chakra-ui/react";

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
 * @returns {React.JSX.Element}
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
        <Card.Root variant="outline" size="sm" w="full">
            <Card.Body>
                <VStack gap={2} align="stretch">
                    <HStack gap={2} align="flex-end">
                        <Field.Root flex="1">
                            <label htmlFor={`shortcut-pattern-${rowKey}`} style={{ fontSize: "0.75rem", marginBottom: "0.25rem" }}>Pattern (regex)</label>
                            <Input
                                id={`shortcut-pattern-${rowKey}`}
                                size="sm"
                                value={pattern}
                                onChange={(e) => handleChange("pattern", e.target.value)}
                                placeholder="e.g. breakfast"
                                fontFamily="mono"
                            />
                        </Field.Root>
                        <Field.Root flex="1">
                            <label htmlFor={`shortcut-replacement-${rowKey}`} style={{ fontSize: "0.75rem", marginBottom: "0.25rem" }}>Replacement</label>
                            <Input
                                id={`shortcut-replacement-${rowKey}`}
                                size="sm"
                                value={replacement}
                                onChange={(e) => handleChange("replacement", e.target.value)}
                                placeholder="e.g. food [when this morning]"
                                fontFamily="mono"
                            />
                        </Field.Root>
                        <IconButton
                            aria-label="Delete shortcut"
                            size="sm"
                            colorScheme="red"
                            variant="ghost"
                            onClick={() => onDelete(rowKey)}><Text>✕</Text></IconButton>
                    </HStack>
                    <Field.Root>
                        <label htmlFor={`shortcut-description-${rowKey}`} style={{ fontSize: "0.75rem", marginBottom: "0.25rem" }}>Description (optional)</label>
                        <Input
                            id={`shortcut-description-${rowKey}`}
                            size="sm"
                            value={description || ""}
                            onChange={(e) => handleChange("description", e.target.value)}
                            placeholder="What does this shortcut do?"
                        />
                    </Field.Root>
                </VStack>
            </Card.Body>
        </Card.Root>
    );
}
