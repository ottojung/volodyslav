/**
 * Utility functions for DescriptionEntry component
 */

import { DateTime } from 'luxon';

/**
 * Formats a date string into a human-readable relative time format
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string
 */
export const formatRelativeDate = (dateString) => {
    const date = DateTime.fromISO(dateString);
    const now = DateTime.now();
    const diff = now.diff(date);
    const diffMs = diff.as('milliseconds');
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleString();
};

/**
 * Validates if a description is valid for submission
 * @param {string} description - The description to validate
 * @returns {boolean} Whether the description is valid
 */
export const isValidDescription = (description) => {
    return Boolean(description && description.trim().length > 0);
};

/** @type {'top'} */
const TOAST_POSITION_TOP = 'top';
/** @type {'warning'} */
const TOAST_WARNING = 'warning';
/** @type {'success'} */
const TOAST_SUCCESS = 'success';
/** @type {'error'} */
const TOAST_ERROR = 'error';

/**
 * Creates toast notification configurations
 */
export const createToastConfig = {
    emptyDescription: () => ({
        title: "Empty description",
        description: "Please enter a description before saving.",
        status: TOAST_WARNING,
        duration: 3000,
        isClosable: true,
        position: TOAST_POSITION_TOP,
    }),
    
    success: (/** @type {string} */ savedInput) => ({
        title: "Event logged successfully",
        description: `Saved: ${savedInput}`,
        status: TOAST_SUCCESS,
        duration: 4000,
        isClosable: true,
        position: TOAST_POSITION_TOP,
    }),
    
    error: (/** @type {string} */ errorMessage) => ({
        title: "Error logging event",
        description: errorMessage || "Please check your connection and try again.",
        status: TOAST_ERROR,
        duration: 5000,
        isClosable: true,
        position: TOAST_POSITION_TOP,
    }),
    
    warning: (/** @type {string} */ warningMessage) => ({
        title: "Warning",
        description: warningMessage || "Please check and try again.",
        status: TOAST_WARNING,
        duration: 5000,
        isClosable: true,
        position: TOAST_POSITION_TOP,
    }),
};
