// Error classes for the DescriptionEntry module
// Extracted from errors.js

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
        // eslint-disable-next-line volodyslav/no-date-class -- Frontend error timestamping
        this.timestamp = new Date().toISOString();
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

