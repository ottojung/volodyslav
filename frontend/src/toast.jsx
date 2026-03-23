import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

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
    /** @type {[Array<{ id: number, title?: string, description?: string }>, React.Dispatch<React.SetStateAction<Array<{ id: number, title?: string, description?: string }>>>]} */
    const [toasts, setToasts] = useState(makeEmptyToasts());
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
            setTimeout(() => {
                setToasts((current) => current.filter((item) => item.id !== id));
            }, duration);
        }
    },
        [],
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
