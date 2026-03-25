import React from "react";
import { VStack, Input, Button, HStack, Card, Badge } from "@chakra-ui/react";
import { 
    CARD_STYLES, 
    SPACING,
    INPUT_STYLES,
} from "./styles.js";

/**
 * Form input section component
 * @param {Object} props
 * @param {string} props.description - Current description value
 * @param {(value: string) => void} props.onDescriptionChange - Description change handler
 * @param {() => void} props.onTakePhotos - Take photos handler
 * @param {() => void} props.onSubmit - Submit handler
 * @param {(e: React.KeyboardEvent) => void} props.onKeyUp - Key up handler
 * @param {boolean} props.isSubmitting - Whether form is submitting
 * @param {React.RefObject<HTMLInputElement | null>} props.inputRef - Input element ref
 * @param {number} [props.photoCount] - Number of photos attached
 * @returns {React.JSX.Element}
 */
export const FormInputSection = ({
    description,
    onDescriptionChange,
    onTakePhotos,
    onSubmit,
    onKeyUp,
    isSubmitting,
    inputRef,
    photoCount = 0,
}) => {
    return (
        <Card.Root {...CARD_STYLES.main}>
            <Card.Body p={SPACING.xl}>
                <VStack gap={SPACING.lg} align="stretch">
                    <Input
                        placeholder="Type your event description here..."
                        value={description}
                        onChange={(e) => onDescriptionChange(e.target.value)}
                        onKeyUp={onKeyUp}
                        ref={inputRef}
                        {...INPUT_STYLES}
                    />

                    {photoCount > 0 && (
                        <HStack justify="flex-start">
                            <Badge colorPalette="green" fontSize="xs">
                                📸 +{photoCount} {photoCount === 1 ? 'photo' : 'photos'}
                            </Badge>
                        </HStack>
                    )}

                    <HStack justify="flex-end" gap={2}>
                        {!isSubmitting && (
                            <Button
                                variant="ghost"
                                color="gray.600"
                                onClick={onTakePhotos}
                                size="sm"
                            >
                                📸 Take Photos
                            </Button>
                        )}
                        <Button
                            colorPalette="blue"
                            px={8}
                            borderRadius="xl"
                            onClick={onSubmit}
                            size="sm"
                            loading={isSubmitting}
                            loadingText="Submitting..."
                        >
                            Submit
                        </Button>
                    </HStack>
                </VStack>
            </Card.Body>
        </Card.Root>
    );
};
