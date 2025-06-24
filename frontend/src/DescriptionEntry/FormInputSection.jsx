import React from "react";
import {
    VStack,
    Input,
    Button,
    Text,
    HStack,
    Card,
    CardBody,
} from "@chakra-ui/react";
import { isValidDescription } from "./utils.js";
import { 
    CARD_STYLES, 
    INPUT_STYLES, 
    BUTTON_STYLES, 
    TEXT_STYLES, 
    SPACING 
} from "./styles.js";

/**
 * Form input section component
 * @param {Object} props
 * @param {string} props.description - Current description value
 * @param {(value: string) => void} props.onDescriptionChange - Description change handler
 * @param {() => void} props.onSubmit - Form submit handler
 * @param {() => void} props.onClear - Clear form handler
 * @param {(e: React.KeyboardEvent) => void} props.onKeyUp - Key up handler
 * @param {boolean} props.isSubmitting - Whether form is submitting
 * @param {React.RefObject<HTMLInputElement>} props.inputRef - Input element ref
 */
export const FormInputSection = ({
    description,
    onDescriptionChange,
    onSubmit,
    onClear,
    onKeyUp,
    isSubmitting,
    inputRef,
}) => {
    const isValidInput = isValidDescription(description);

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

                    <HStack spacing={SPACING.md} justify="space-between">
                        <Text {...TEXT_STYLES.helper}>
                            Press Enter to log event
                        </Text>
                        <HStack spacing={SPACING.sm}>
                            <Button
                                {...BUTTON_STYLES.secondary}
                                onClick={onClear}
                                isDisabled={!isValidInput || isSubmitting}
                            >
                                Clear
                            </Button>
                            <Button
                                {...BUTTON_STYLES.primary}
                                onClick={onSubmit}
                                isLoading={isSubmitting}
                                loadingText="Logging..."
                                isDisabled={!isValidInput}
                            >
                                Log Event
                            </Button>
                        </HStack>
                    </HStack>
                </VStack>
            </CardBody>
        </Card>
    );
};
