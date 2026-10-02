import React, { useState, useCallback, useEffect, useRef } from "react";
import { Button, HStack, Stack, Text } from "@chakra-ui/react";

/**
 * @typedef {object} DiscardControlProps
 * @property {() => void} onDiscard - Called only when the user confirms the discard.
 * @property {string} subject - Identifies the recording the confirmation is about.
 *   Changing it voids an armed confirmation, because the confirmation was about
 *   the previous subject and the user no longer believes they are still looking
 *   at that one.
 * @property {"full" | "flex"} layout - How the control occupies its slot: `full`
 *   spans the column, `flex` shares a row with a sibling action. The armed
 *   confirmation takes the same slot as the trigger it replaces, so a
 *   confirmation never crowds the sibling it shares a row with.
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
 * The armed state is not a sticky mode. It is dismissed by exactly three paths:
 * Escape, the explicit keep control, and a change of `subject` such as the
 * recorder moving between states. Every one of those paths puts focus back on
 * the trigger, because the trigger is unmounted while the confirmation is shown
 * and the keyboard user would otherwise land on the document body. The confirm
 * path deliberately does not restore focus, because there is no recording left
 * to discard a second time.
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
    /** @type {import("react").RefObject<HTMLButtonElement | null>} */
    const triggerRef = useRef(null);
    const shouldRestoreFocusRef = useRef(false);

    const dismiss = useCallback(() => {
        shouldRestoreFocusRef.current = true;
        setIsConfirming(false);
    }, []);

    const armedSubjectRef = useRef(subject);

    useEffect(() => {
        if (armedSubjectRef.current !== subject) {
            armedSubjectRef.current = subject;
            dismiss();
        }
    }, [subject, dismiss]);

    useEffect(() => {
        if (!isConfirming && shouldRestoreFocusRef.current) {
            shouldRestoreFocusRef.current = false;
            triggerRef.current?.focus();
        }
    }, [isConfirming]);

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
            <Stack
                direction={layout === "flex" ? "row" : "column"}
                align={layout === "flex" ? "center" : "stretch"}
                gap={2}
                p={3}
                borderWidth="1px"
                borderColor="red.300"
                borderRadius="md"
                {...(layout === "flex"
                    ? { flex: 1, minW: 0, w: "full" }
                    : { w: "full" })}
                data-testid="discard-confirmation"
            >
                <Text
                    fontSize="sm"
                    color="red.600"
                    fontWeight="semibold"
                    flex={layout === "flex" ? 1 : undefined}
                    minW={0}
                >
                    Discard this recording? It cannot be recovered.
                </Text>
                <HStack gap={2} justify="flex-end" flexShrink={0}>
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
            </Stack>
        );
    }

    return (
        <Button
            colorPalette="red"
            variant="outline"
            size={layout === "flex" ? undefined : "sm"}
            flex={layout === "flex" ? 1 : undefined}
            w={layout === "flex" ? undefined : "full"}
            onClick={() => setIsConfirming(true)}
            ref={triggerRef}
            data-testid="discard-button"
        >
            Discard
        </Button>
    );
}
