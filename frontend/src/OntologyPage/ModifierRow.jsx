import React from "react";
import { Card, HStack, IconButton, Input, Textarea, Text, VStack, Field } from "@chakra-ui/react";

/**
 * @typedef {import('../DescriptionEntry/api.js').OntologyModifierEntry} OntologyModifierEntry
 */

const labelStyle = {
    fontSize: "0.75rem",
    marginBottom: "0.25rem",
};

/**
 * A single modifier row in the ontology editor.
 * @param {Object} props
 * @param {number} props.rowKey - Stable key used for identification
 * @param {OntologyModifierEntry} props.entry - The modifier entry
 * @param {(rowKey: number, updated: OntologyModifierEntry) => void} props.onChange - Called when any field changes
 * @param {(rowKey: number) => void} props.onDelete - Called when delete is clicked
 * @returns {React.JSX.Element}
 */
export function ModifierRow({ rowKey, entry, onChange, onDelete }) {
    /**
     * @param {string} field
     * @param {string} value
     */
    function handleChange(field, value) {
        if (field === "only_for_type") {
            if (value) {
                onChange(rowKey, { ...entry, only_for_type: value });
            } else {
                onChange(rowKey, { name: entry.name, description: entry.description });
            }
        } else {
            onChange(rowKey, { ...entry, [field]: value });
        }
    }

    return (
        <Card.Root variant="outline" size="sm" w="full">
            <Card.Body>
                <VStack gap={2} align="stretch">
                    <HStack gap={2} align="flex-end">
                        <Field.Root flex="1">
                            <label htmlFor={`modifier-name-${rowKey}`} style={labelStyle}>Modifier Name</label>
                            <Input
                                id={`modifier-name-${rowKey}`}
                                size="sm"
                                value={entry.name}
                                onChange={(e) => handleChange("name", e.target.value)}
                                placeholder="e.g., when"
                            />
                        </Field.Root>
                        <Field.Root flex="1">
                            <label htmlFor={`modifier-only-for-type-${rowKey}`} style={labelStyle}>Only for type (optional)</label>
                            <Input
                                id={`modifier-only-for-type-${rowKey}`}
                                size="sm"
                                value={entry.only_for_type || ""}
                                onChange={(e) => handleChange("only_for_type", e.target.value)}
                                placeholder="e.g., food"
                            />
                        </Field.Root>
                        <IconButton
                            aria-label="Remove modifier"
                            size="sm"
                            colorScheme="red"
                            variant="ghost"
                            onClick={() => onDelete(rowKey)}
                        >
                            <Text>✕</Text>
                        </IconButton>
                    </HStack>
                    <Field.Root>
                        <label htmlFor={`modifier-description-${rowKey}`} style={labelStyle}>Description</label>
                        <Textarea
                            id={`modifier-description-${rowKey}`}
                            size="sm"
                            value={entry.description}
                            onChange={(e) => handleChange("description", e.target.value)}
                            placeholder="Describe what this modifier means..."
                            rows={2}
                        />
                    </Field.Root>
                </VStack>
            </Card.Body>
        </Card.Root>
    );
}
