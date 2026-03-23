import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

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
 * Legacy-compatible toast API for the existing frontend call sites.
 * @returns {(options: ToastOptions) => void}
 */
const ToastContext = createContext(
    /**
     * @param {ToastOptions} _options
     */
    (_options) => {},
);

/**
 * @returns {(options: ToastOptions) => void}
 */
export function useToast() {
    return useContext(ToastContext);
}

/**
 * @param {{ children?: React.ReactNode }} props
 * @returns {React.JSX.Element}
 */
export function ToastProvider({ children }) {
    const nextToastIdRef = useRef(0);
    /** @type {React.MutableRefObject<Map<number, ReturnType<typeof setTimeout>>>} */
    const timeoutMapRef = useRef(new Map());
    /** @type {[Array<{ id: number, title?: string, description?: string }>, React.Dispatch<React.SetStateAction<Array<{ id: number, title?: string, description?: string }>>>]} */
    const [toasts, setToasts] = useState(makeEmptyToasts());

    useEffect(() => {
        return () => {
            for (const timeoutId of timeoutMapRef.current.values()) {
                clearTimeout(timeoutId);
            }
            timeoutMapRef.current.clear();
        };
    }, []);

    /**
     * @param {number} id
     */
    const removeToast = useCallback(
        /**
         * @param {number} id
         */
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
        /**
         * @param {ToastOptions} options
         */
        (options) => {
        nextToastIdRef.current += 1;
        const id = nextToastIdRef.current;
        setToasts((current) => [...current, { id, title: options.title, description: options.description }]);
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

    return (
        <ToastContext.Provider value={contextValue}>
            {children}
            <div aria-live="polite">
                {toasts.map((item) => (
                    <div key={item.id}>
                        {item.title && <div>{item.title}</div>}
                        {item.description && <div>{item.description}</div>}
                        <button type="button" onClick={() => removeToast(item.id)} aria-label="Dismiss toast">
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

/**
 * @returns {Array<{ id: number, title?: string, description?: string }>}
 */
function makeEmptyToasts() {
    return [];
}
