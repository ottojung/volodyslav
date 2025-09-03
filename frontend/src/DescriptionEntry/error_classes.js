// Error classes for the DescriptionEntry module
// Extracted from errors.js

/**
 * Get current time as ISO string without using Date
 * @returns {string} Current time in ISO format
 */
function getCurrentISOString() {
    const now = performance.timeOrigin + performance.now();
    return timestampToISOString(now);
}

/**
 * Convert timestamp to ISO string manually
 * @param {number} timestamp - Milliseconds since epoch
 * @returns {string} ISO string representation
 */
function timestampToISOString(timestamp) {
    const daysSinceEpoch = Math.floor(timestamp / (24 * 60 * 60 * 1000));
    const timeOfDayMs = timestamp % (24 * 60 * 60 * 1000);
    
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
    
    // Calculate time components
    const hour = Math.floor(timeOfDayMs / (60 * 60 * 1000));
    const minute = Math.floor((timeOfDayMs % (60 * 60 * 1000)) / (60 * 1000));
    const second = Math.floor((timeOfDayMs % (60 * 1000)) / 1000);
    const ms = timeOfDayMs % 1000;
    
    // Format as ISO string
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(Math.floor(ms)).padStart(3, '0')}Z`;
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
 * Base class for all DescriptionEntry-related errors
 */
export class DescriptionEntryError extends Error {
    /**
     * @param {string} message - Error message
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, cause = null) {
        super(message);
        this.name = this.constructor.name;
        this.cause = cause;
        this.timestamp = getCurrentISOString();
    }
}

/**
 * Error thrown when photo retrieval fails
 */
export class PhotoRetrievalError extends DescriptionEntryError {
    /**
     * @param {string} message - Error message
     * @param {string|null} requestIdentifier - Request identifier for the photos
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, requestIdentifier = null, cause = null) {
        super(message, cause);
        this.requestIdentifier = requestIdentifier;
        this.isRecoverable = true; // User can choose to submit without photos
    }
}

/**
 * Error thrown when photo storage fails
 */
export class PhotoStorageError extends DescriptionEntryError {
    /**
     * @param {string} message - Error message
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, cause = null) {
        super(message, cause);
        this.isRecoverable = false; // Storage failure usually requires retry
    }
}

/**
 * Error thrown when photo conversion fails
 */
export class PhotoConversionError extends DescriptionEntryError {
    /**
     * @param {string} message - Error message
     * @param {string|null} photoName - Name of the photo that failed conversion
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, photoName = null, cause = null) {
        super(message, cause);
        this.photoName = photoName;
        this.isRecoverable = false; // Conversion failure requires retry
    }
}

/**
 * Error thrown when camera access fails
 */
export class CameraAccessError extends DescriptionEntryError {
    /**
     * @param {string} message - Error message
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, cause = null) {
        super(message, cause);
        this.isRecoverable = false; // Camera issues usually need manual resolution
    }
}

/**
 * Error thrown when entry submission fails
 */
export class EntrySubmissionError extends DescriptionEntryError {
    /**
     * @param {string} message - Error message
     * @param {number|null} statusCode - HTTP status code if applicable
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, statusCode = null, cause = null) {
        super(message, cause);
        /** @type {number|null} */
        this.statusCode = statusCode;
        this.isRecoverable = true; // Most submission errors can be retried
    }
}

/**
 * Error thrown when session storage operations fail
 */
export class SessionStorageError extends DescriptionEntryError {
    /**
     * @param {string} message - Error message
     * @param {string|null} operation - The storage operation that failed
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, operation = null, cause = null) {
        super(message, cause);
        this.operation = operation; // 'get', 'set', 'remove'
        this.isRecoverable = true; // Storage issues might resolve or user can retry
    }
}

