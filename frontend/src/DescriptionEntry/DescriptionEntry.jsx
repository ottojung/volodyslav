import React, { useRef, useEffect } from "react";
import { VStack, Container } from "@chakra-ui/react";
import { useDescriptionEntry } from "./hooks.js";
import { FormInputSection } from "./FormInputSection.jsx";
import { ConfigSection } from "./ConfigSection.jsx";
import { SPACING, SIZES } from "./styles.js";

export default function DescriptionEntry() {
    const {
        description,
        isSubmitting,
        photoCount,
        setDescription,
        handleSubmit,
        handleTakePhotos,
        handleKeyUp,
    } = useDescriptionEntry();

    const inputRef = useRef(null);

    useEffect(() => {
        if (inputRef.current) {
            // @ts-expect-error: inputRef is not typed, but focus() is valid for Chakra Input
            inputRef.current.focus();
        }
    }, []);

    const handleShortcutClick = (/** @type {string} */ text) => {
        setDescription(text);
        // Focus the input after setting the text
        if (inputRef.current) {
            // @ts-expect-error: inputRef is not typed, but focus() is valid for Chakra Input
            inputRef.current.focus();
        }
    };

    return (
        <Container maxW={SIZES.containerMaxW} px={4} py={SPACING.xxl}>
            <VStack
                spacing={SPACING.xxl}
                align="stretch"
                justify="flex-start"
                minH="70vh"
            >
                {/* Main Input Form */}
                <FormInputSection
                    description={description}
                    onDescriptionChange={setDescription}
                    onTakePhotos={handleTakePhotos}
                    onSubmit={handleSubmit}
                    onKeyUp={handleKeyUp}
                    isSubmitting={isSubmitting}
                    inputRef={inputRef}
                    photoCount={photoCount}
                />

                {/* Configuration Section */}
                <ConfigSection
                    onShortcutClick={handleShortcutClick}
                    currentInput={description}
                />
            </VStack>
        </Container>
    );
}
