/**
 * Utility functions for DescriptionEntry component
 */

/**
 * Formats a date string into a human-readable relative time format
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string
 */
export const formatRelativeDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
};

/**
 * Validates if a description is valid for submission
 * @param {string} description - The description to validate
 * @returns {boolean} Whether the description is valid
 */
export const isValidDescription = (description) => {
    return Boolean(description && description.trim().length > 0);
};

/**
 * Creates toast notification configurations
 */
export const createToastConfig = {
    emptyDescription: () => ({
        title: "Empty description",
        description: "Please enter a description before saving.",
        status: /** @type {"warning"} */ ("warning"),
        duration: 3000,
        isClosable: true,
        position: /** @type {"top"} */ ("top"),
    }),
    
    success: (/** @type {string} */ savedInput) => ({
        title: "Event logged successfully",
        description: `Saved: ${savedInput}`,
        status: /** @type {"success"} */ ("success"),
        duration: 4000,
        isClosable: true,
        position: /** @type {"top"} */ ("top"),
    }),
    
    error: (/** @type {string} */ errorMessage) => ({
        title: "Error logging event",
        description: errorMessage || "Please check your connection and try again.",
        status: /** @type {"error"} */ ("error"),
        duration: 5000,
        isClosable: true,
        position: /** @type {"top"} */ ("top"),
    }),
    
    warning: (/** @type {string} */ warningMessage) => ({
        title: "Warning",
        description: warningMessage || "Please check and try again.",
        status: /** @type {"warning"} */ ("warning"),
        duration: 5000,
        isClosable: true,
        position: /** @type {"top"} */ ("top"),
    }),
};
