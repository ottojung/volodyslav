import React from "react";
import {
    VStack,
    Input,
    Button,
    HStack,
    Card,
    CardBody,
    Badge,
} from "@chakra-ui/react";
import { 
    CARD_STYLES, 
    INPUT_STYLES, 
    BUTTON_STYLES, 
    SPACING 
} from "./styles.js";

/**
 * Form input section component
 * @param {Object} props
 * @param {string} props.description - Current description value
 * @param {(value: string) => void} props.onDescriptionChange - Description change handler
 * @param {() => void} props.onTakePhotos - Take photos handler
 * @param {(e: React.KeyboardEvent) => void} props.onKeyUp - Key up handler
 * @param {boolean} props.isSubmitting - Whether form is submitting
 * @param {React.RefObject<HTMLInputElement>} props.inputRef - Input element ref
 * @param {number} [props.photoCount] - Number of photos attached
 * @returns {JSX.Element}
 */
export const FormInputSection = ({
    description,
    onDescriptionChange,
    onTakePhotos,
    onKeyUp,
    isSubmitting,
    inputRef,
    photoCount = 0,
}) => {
    return (
        <Card {...CARD_STYLES.main}>
            <CardBody p={SPACING.xl}>
                <VStack spacing={SPACING.lg} align="stretch">
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
                            <Badge colorScheme="green" fontSize="xs">
                                📸 +{photoCount} {photoCount === 1 ? 'photo' : 'photos'}
                            </Badge>
                        </HStack>
                    )}

                    <HStack justify="flex-end">
                        <Button
                            {...BUTTON_STYLES.secondary}
                            onClick={onTakePhotos}
                            size="sm"
                            isDisabled={isSubmitting}
                        >
                            📸 Take Photos
                        </Button>
                    </HStack>
                </VStack>
            </CardBody>
        </Card>
    );
};
