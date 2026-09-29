import React, { useState, useCallback, useEffect } from "react";
import { Button, HStack, Text, VStack } from "@chakra-ui/react";

/**
 * @typedef {object} DiscardControlProps
 * @property {() => void} onDiscard - Called only when the user confirms the discard.
 * @property {string} subject - Identifies the recording the confirmation is about.
 *   Changing it voids an armed confirmation, because the confirmation was about
 *   the previous subject and the user no longer believes they are still looking
 *   at that one.
 * @property {"full" | "flex"} layout - How the control occupies its slot: `full`
 *   spans the column, `flex` shares a row with a sibling action.
 */

/**
 * A two-step discard control.
 *
 * Discarding a diary recording destroys it irrecoverably: the local MediaRecorder
 * chunks are dropped and the server-side session holding the uploaded PCM is
 * deleted, with no undo and no recovery path. The first press therefore does not
 * discard. It arms a confirmation that spells out the consequence in words, and a
 * second deliberate press is required to actually discard.
 *
 * The armed state is transient and self-expiring rather than a sticky mode: it is
 * dismissed by Escape, by the explicit keep control, and by any change of
 * `subject` such as the recorder moving between states. An armed confirmation can
 * therefore never fire against a recording the user no longer believes they are
 * looking at.
 *
 * The confirmation is rendered inline instead of in a modal because the whole
 * point of the guard is that the user's attention is not where their thumb is;
 * a modal would move the tap target to a fresh button somewhere else on screen
 * and introduce a second accident surface rather than remove one.
 *
 * @param {DiscardControlProps} props
 * @returns {React.JSX.Element}
 */
export default function DiscardControl({ onDiscard, subject, layout }) {
    const [isConfirming, setIsConfirming] = useState(false);

    const dismiss = useCallback(() => {
        setIsConfirming(false);
    }, []);

    useEffect(() => {
        setIsConfirming(false);
    }, [subject]);

    useEffect(() => {
        if (!isConfirming) {
            return undefined;
        }

        /**
         * @param {KeyboardEvent} event
         * @returns {void}
         */
        function handleKeyDown(event) {
            if (event.key === "Escape") {
                dismiss();
            }
        }

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [isConfirming, dismiss]);

    if (isConfirming) {
        return (
            <VStack
                w="full"
                align="stretch"
                gap={2}
                p={3}
                borderWidth="1px"
                borderColor="red.300"
                borderRadius="md"
                data-testid="discard-confirmation"
            >
                <Text fontSize="sm" color="red.600" fontWeight="semibold">
                    Discard this recording? It cannot be recovered.
                </Text>
                <HStack gap={2} justify="flex-end">
                    <Button
                        variant="ghost"
                        size="xs"
                        onClick={dismiss}
                        autoFocus
                        data-testid="discard-keep-button"
                    >
                        Keep recording
                    </Button>
                    <Button
                        colorPalette="red"
                        size="xs"
                        onClick={onDiscard}
                        data-testid="discard-confirm-button"
                    >
                        Yes, discard
                    </Button>
                </HStack>
            </VStack>
        );
    }

    if (layout === "flex") {
        return (
            <Button
                colorPalette="red"
                variant="outline"
                flex={1}
                onClick={() => setIsConfirming(true)}
                data-testid="discard-button"
            >
                Discard
            </Button>
        );
    }

    return (
        <Button
            colorPalette="red"
            variant="outline"
            size="sm"
            w="full"
            onClick={() => setIsConfirming(true)}
            data-testid="discard-button"
        >
            Discard
        </Button>
    );
}
