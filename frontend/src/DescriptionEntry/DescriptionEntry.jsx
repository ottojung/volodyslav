import React, { useRef, useEffect } from "react";
import { VStack, Container } from "@chakra-ui/react";
import { useDescriptionEntry } from "./hooks.js";
import { FormInputSection } from "./FormInputSection.jsx";
import { ConfigSection } from "./ConfigSection.jsx";
import { SPACING, SIZES } from "./styles.js";

const NUMBER_OF_RECENT_ENTRIES = 10;

export default function DescriptionEntry() {
    const {
        description,
        isSubmitting,
        recentEntries,
        isLoadingEntries,
        pendingRequestIdentifier,
        setDescription,
        handleTakePhotos,
        handleKeyUp,
    } = useDescriptionEntry(NUMBER_OF_RECENT_ENTRIES);

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
                justify="center"
                minH="70vh"
            >
                {/* Main Input Form */}
                <FormInputSection
                    description={description}
                    onDescriptionChange={setDescription}
                    onTakePhotos={handleTakePhotos}
                    onKeyUp={handleKeyUp}
                    isSubmitting={isSubmitting}
                    inputRef={inputRef}
                    hasPhotos={!!pendingRequestIdentifier}
                />

                {/* Configuration Section */}
                <ConfigSection
                    onShortcutClick={handleShortcutClick}
                    currentInput={description}
                    recentEntries={recentEntries}
                    isLoadingEntries={isLoadingEntries}
                />
            </VStack>
        </Container>
    );
}
