/**
 * Utility functions for DescriptionEntry component
 */

/**
 * Formats a date string into a human-readable relative time format
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string
 */
export const formatRelativeDate = (dateString) => {
    try {
        // Parse the ISO date string manually to avoid using Date constructor
        const parsedDate = parseISOString(dateString);
        const now = getCurrentTimeMs();
        const diffMs = now - parsedDate;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) return "just now";
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;

        // For dates older than a week, format as a simple date string
        return formatDateOnly(parsedDate);
    } catch (error) {
        // Fallback for malformed dates
        return dateString;
    }
};

/**
 * Parse an ISO string to milliseconds using manual calculation
 * @param {string} isoString - ISO date string like "2023-12-25T10:30:00.000Z"
 * @returns {number} Milliseconds since epoch
 */
function parseISOString(isoString) {
    // Handle ISO strings with or without milliseconds and timezone
    const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(?:Z|[+-]\d{2}:\d{2})?$/);
    if (!match) {
        throw new Error(`Invalid ISO string: ${isoString}`);
    }
    
    const [, year, month, day, hour, minute, second, ms = '000'] = match;
    
    // Manual UTC calculation to avoid Date constructor
    return calculateUTCTimestamp(
        parseInt(year || '1970', 10),
        parseInt(month || '1', 10) - 1, // month is 0-indexed
        parseInt(day || '1', 10),
        parseInt(hour || '0', 10),
        parseInt(minute || '0', 10),
        parseInt(second || '0', 10),
        parseInt(ms || '0', 10)
    );
}

/**
 * Calculate UTC timestamp manually without using Date
 * @param {number} year - Year (e.g., 2023)
 * @param {number} month - Month (0-indexed, 0 = January)
 * @param {number} day - Day of month (1-31)
 * @param {number} hour - Hour (0-23)
 * @param {number} minute - Minute (0-59)
 * @param {number} second - Second (0-59)
 * @param {number} ms - Milliseconds (0-999)
 * @returns {number} Milliseconds since epoch
 */
function calculateUTCTimestamp(year, month, day, hour, minute, second, ms) {
    // Days since epoch (1970-01-01)
    let daysSinceEpoch = 0;
    
    // Add days for complete years
    for (let y = 1970; y < year; y++) {
        daysSinceEpoch += isLeapYear(y) ? 366 : 365;
    }
    
    // Add days for complete months in the target year
    const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let m = 0; m < month && m < daysInMonth.length; m++) {
        daysSinceEpoch += daysInMonth[m] || 0;
    }
    
    // Add remaining days
    daysSinceEpoch += day - 1; // day is 1-indexed
    
    // Convert to milliseconds
    const totalMs = daysSinceEpoch * 24 * 60 * 60 * 1000 + 
                   hour * 60 * 60 * 1000 + 
                   minute * 60 * 1000 + 
                   second * 1000 + 
                   ms;
    
    return totalMs;
}

/**
 * Check if a year is a leap year
 * @param {number} year - Year to check
 * @returns {boolean} True if leap year
 */
function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Get current time in milliseconds without using Date.now()
 * @returns {number} Current time in milliseconds since epoch
 */
function getCurrentTimeMs() {
    // Use performance.timeOrigin + performance.now() as an alternative to Date.now()
    return performance.timeOrigin + performance.now();
}

/**
 * Format a timestamp as a simple date string (YYYY-MM-DD)
 * @param {number} timestamp - Milliseconds since epoch
 * @returns {string} Date string in YYYY-MM-DD format
 */
function formatDateOnly(timestamp) {
    // Convert timestamp back to date components manually
    const daysSinceEpoch = Math.floor(timestamp / (24 * 60 * 60 * 1000));
    
    let year = 1970;
    let remainingDays = daysSinceEpoch;
    
    // Find the year
    while (remainingDays > 0) {
        const daysInYear = isLeapYear(year) ? 366 : 365;
        if (remainingDays < daysInYear) break;
        remainingDays -= daysInYear;
        year++;
    }
    
    // Find the month and day
    const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let month = 0;
    while (remainingDays >= (daysInMonth[month] || 0) && month < daysInMonth.length) {
        remainingDays -= daysInMonth[month] || 0;
        month++;
    }
    
    const day = remainingDays + 1; // day is 1-indexed
    
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

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
