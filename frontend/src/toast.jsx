import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Box, CloseButton, HStack, Text, VStack } from "@chakra-ui/react";

/**
 * @typedef {object} ToastOptions
 * @property {string} [title]
 * @property {string} [description]
 * @property {"success"|"error"|"warning"|"info"} [status]
 * @property {number|null} [duration]
 * @property {boolean} [isClosable]
 * @property {string} [position]
 */

/**
 * @typedef {object} ActiveToast
 * @property {number} id
 * @property {string | undefined} title
 * @property {string | undefined} description
 * @property {"success"|"error"|"warning"|"info" | undefined} status
 * @property {"top"|"bottom"} position
 * @property {boolean} isClosable
 */

const ToastContext = createContext(
    /** @param {ToastOptions} _options */
    (_options) => {},
);

export function useToast() {
    return useContext(ToastContext);
}

/** @returns {ActiveToast[]} */
function makeEmptyToasts() {
    return [];
}

/** @param {ToastOptions} options @returns {"top"|"bottom"} */
function normalizePosition(options) {
    return options.position === "top" ? "top" : "bottom";
}

/** @param {ActiveToast["status"]} status @returns {string} */
function statusBorderColor(status) {
    if (status === "success") return "green.400";
    if (status === "warning") return "orange.400";
    if (status === "error") return "red.400";
    return "blue.400";
}

/** @param {ActiveToast["status"]} status @returns {"polite"|"assertive"} */
function statusLiveMode(status) {
    if (status === "error" || status === "warning") return "assertive";
    return "polite";
}

/**
 * @param {{ children?: React.ReactNode }} props
 * @returns {React.JSX.Element}
 */
export function ToastProvider({ children }) {
    const nextToastIdRef = useRef(0);
    /** @type {React.MutableRefObject<Map<number, ReturnType<typeof setTimeout>>>} */
    const timeoutMapRef = useRef(new Map());
    /** @type {[ActiveToast[], React.Dispatch<React.SetStateAction<ActiveToast[]>>]} */
    const [toasts, setToasts] = useState(makeEmptyToasts());

    useEffect(() => {
        return () => {
            for (const timeoutId of timeoutMapRef.current.values()) {
                clearTimeout(timeoutId);
            }
            timeoutMapRef.current.clear();
        };
    }, []);

    const removeToast = useCallback(
        /** @param {number} id */
        (id) => {
            const timeoutId = timeoutMapRef.current.get(id);
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutMapRef.current.delete(id);
            }
            setToasts((current) => current.filter((item) => item.id !== id));
        },
        [],
    );

    const toast = useCallback(
        /** @param {ToastOptions} options */
        (options) => {
            nextToastIdRef.current += 1;
            const id = nextToastIdRef.current;

            setToasts((current) => [
                ...current,
                {
                    id,
                    title: options.title,
                    description: options.description,
                    status: options.status,
                    position: normalizePosition(options),
                    isClosable: options.isClosable !== false,
                },
            ]);

            if (options.duration !== null) {
                const duration = options.duration ?? 3000;
                const timeoutId = setTimeout(() => {
                    removeToast(id);
                }, duration);
                timeoutMapRef.current.set(id, timeoutId);
            }
        },
        [removeToast],
    );

    const contextValue = useMemo(() => toast, [toast]);
    const topToasts = toasts.filter((item) => item.position === "top");
    const bottomToasts = toasts.filter((item) => item.position === "bottom");

    return (
        <ToastContext.Provider value={contextValue}>
            {children}

            <VStack position="fixed" top={4} left={0} right={0} zIndex={2000} pointerEvents="none" gap={3}>
                {topToasts.map((item) => (
                    <ToastCard key={item.id} item={item} onClose={removeToast} />
                ))}
            </VStack>

            <VStack position="fixed" bottom={4} left={0} right={0} zIndex={2000} pointerEvents="none" gap={3}>
                {bottomToasts.map((item) => (
                    <ToastCard key={item.id} item={item} onClose={removeToast} />
                ))}
            </VStack>
        </ToastContext.Provider>
    );
}

/**
 * @param {{ item: ActiveToast, onClose: (id: number) => void }} props
 * @returns {React.JSX.Element}
 */
function ToastCard({ item, onClose }) {
    const liveMode = statusLiveMode(item.status);
    const role = liveMode === "assertive" ? "alert" : "status";

    return (
        <Box
            pointerEvents="auto"
            bg="bg.panel"
            borderWidth="1px"
            borderLeftWidth="4px"
            borderLeftColor={statusBorderColor(item.status)}
            borderColor="border"
            borderRadius="md"
            boxShadow="lg"
            px={4}
            py={3}
            maxW="min(90vw, 28rem)"
            w="full"
            role={role}
            aria-live={liveMode}
            aria-atomic="true"
        >
            <HStack align="start" justify="space-between" gap={3}>
                <VStack align="start" gap={0} flex="1">
                    {item.title ? <Text fontWeight="semibold">{item.title}</Text> : null}
                    {item.description ? <Text fontSize="sm">{item.description}</Text> : null}
                </VStack>
                {item.isClosable ? (
                    <CloseButton size="sm" onClick={() => onClose(item.id)} aria-label="Dismiss toast" />
                ) : null}
            </HStack>
        </Box>
    );
}
