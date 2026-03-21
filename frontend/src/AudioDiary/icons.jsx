import React from "react";

/**
 * Microphone SVG icon.
 * @param {import('react').SVGProps<SVGSVGElement>} props
 * @returns {import('react').JSX.Element}
 */
export function MicrophoneIcon(props) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
            {...props}
        >
            <path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3z" />
            <path d="M19 11a1 1 0 00-2 0 5 5 0 01-10 0 1 1 0 00-2 0 7 7 0 006 6.93V20H9a1 1 0 000 2h6a1 1 0 000-2h-2v-2.07A7 7 0 0019 11z" />
        </svg>
    );
}

/**
 * Pause SVG icon.
 * @param {import('react').SVGProps<SVGSVGElement>} props
 * @returns {import('react').JSX.Element}
 */
export function PauseIcon(props) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
            {...props}
        >
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
        </svg>
    );
}

/**
 * Stop (square) SVG icon.
 * @param {import('react').SVGProps<SVGSVGElement>} props
 * @returns {import('react').JSX.Element}
 */
export function StopIcon(props) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
            {...props}
        >
            <path d="M6 6h12v12H6z" />
        </svg>
    );
}
