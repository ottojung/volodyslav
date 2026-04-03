import React from "react";
import { Card, HStack, IconButton, Input, Textarea, Text, VStack, Field } from "@chakra-ui/react";

/**
 * @typedef {import('../DescriptionEntry/api.js').OntologyTypeEntry} OntologyTypeEntry
 */

const labelStyle = {
    fontSize: "0.75rem",
    marginBottom: "0.25rem",
};

/**
 * A single type row in the ontology editor.
 * @param {Object} props
 * @param {number} props.rowKey - Stable key used for identification
 * @param {OntologyTypeEntry} props.entry - The type entry
 * @param {(rowKey: number, updated: OntologyTypeEntry) => void} props.onChange - Called when any field changes
 * @param {(rowKey: number) => void} props.onDelete - Called when delete is clicked
 * @returns {React.JSX.Element}
 */
export function TypeRow({ rowKey, entry, onChange, onDelete }) {
    /**
     * @param {string} field
     * @param {string} value
     */
    function handleChange(field, value) {
        onChange(rowKey, { ...entry, [field]: value });
    }

    return (
        <Card.Root variant="outline" size="sm" w="full">
            <Card.Body>
                <VStack gap={2} align="stretch">
                    <HStack gap={2} align="flex-end">
                        <Field.Root flex="1">
                            <label htmlFor={`type-name-${rowKey}`} style={labelStyle}>Type Name</label>
                            <Input
                                id={`type-name-${rowKey}`}
                                size="sm"
                                value={entry.name}
                                onChange={(e) => handleChange("name", e.target.value)}
                                placeholder="e.g., food"
                            />
                        </Field.Root>
                        <IconButton
                            aria-label="Remove type"
                            size="sm"
                            colorScheme="red"
                            variant="ghost"
                            onClick={() => onDelete(rowKey)}
                        >
                            <Text>✕</Text>
                        </IconButton>
                    </HStack>
                    <Field.Root>
                        <label htmlFor={`type-description-${rowKey}`} style={labelStyle}>Description</label>
                        <Textarea
                            id={`type-description-${rowKey}`}
                            size="sm"
                            value={entry.description}
                            onChange={(e) => handleChange("description", e.target.value)}
                            placeholder="Describe what this type means..."
                            rows={2}
                        />
                    </Field.Root>
                </VStack>
            </Card.Body>
        </Card.Root>
    );
}
