// Helper functions and constants for DescriptionEntry errors
// Extracted from errors.js

import {
    DescriptionEntryError,
    PhotoRetrievalError,
    PhotoStorageError,
    PhotoConversionError,
    CameraAccessError,
    EntrySubmissionError,
    SessionStorageError,
} from './error_classes.js';

/**
 * Type guards for error identification
 */

/**
 * @param {unknown} error
 * @returns {error is PhotoRetrievalError}
 */
export function isPhotoRetrievalError(error) {
    return error instanceof PhotoRetrievalError;
}

/**
 * @param {unknown} error
 * @returns {error is PhotoStorageError}
 */
export function isPhotoStorageError(error) {
    return error instanceof PhotoStorageError;
}

/**
 * @param {unknown} error
 * @returns {error is PhotoConversionError}
 */
export function isPhotoConversionError(error) {
    return error instanceof PhotoConversionError;
}

/**
 * @param {unknown} error
 * @returns {error is CameraAccessError}
 */
export function isCameraAccessError(error) {
    return error instanceof CameraAccessError;
}

/**
 * @param {unknown} error
 * @returns {error is EntrySubmissionError}
 */
export function isEntrySubmissionError(error) {
    return error instanceof EntrySubmissionError;
}

/**
 * @param {unknown} error
 * @returns {error is SessionStorageError}
 */
export function isSessionStorageError(error) {
    return error instanceof SessionStorageError;
}

/**
 * @param {unknown} error
 * @returns {error is DescriptionEntryError}
 */
export function isDescriptionEntryError(error) {
    return error instanceof DescriptionEntryError;
}

/**
 * Error message generators for user-friendly messages
 */
export const ErrorMessages = {
    photoRetrieval: {
        notFound: "No photos found for this session. They may have been cleared or expired.",
        corrupted: "Photo data appears to be corrupted. Please try taking new photos.",
        conversionFailed: "Failed to process one or more photos. Please try taking new photos.",
        sessionStorage: "Unable to access stored photos. Please try taking new photos.",
    },
    photoStorage: {
        quotaExceeded: "Storage space unavailable. Please try again or contact support if the issue persists.",
        accessDenied: "Unable to save photos. Please check your browser settings.",
        genericFailure: "Failed to save photos. Please try again.",
    },
    cameraAccess: {
        permissionDenied: "Camera access was denied. Please enable camera permissions and try again.",
        deviceNotFound: "No camera found. Please ensure your device has a camera.",
        genericFailure: "Unable to access camera. Please try again or use a different device.",
    },
    submission: {
        networkError: "Network error. Please check your internet connection and try again.",
        serverError: "Server error. Please try again in a moment.",
        validationError: /** @param {string} details */ (details) => `Invalid data: ${details}`,
        genericFailure: "Failed to submit entry. Please try again.",
    },
};

/**
 * Gets a user-friendly error message for the given error
 * @param {unknown} error - The error to get a message for
 * @returns {string} - User-friendly error message
 */
export function getUserFriendlyErrorMessage(error) {
    if (isPhotoRetrievalError(error)) {
        if (error.message.includes('JSON')) {
            return ErrorMessages.photoRetrieval.corrupted;
        }
        if (error.message.includes('fetch') || error.message.includes('File')) {
            return ErrorMessages.photoRetrieval.conversionFailed;
        }
        if (error.message.includes('storage')) {
            return ErrorMessages.photoRetrieval.sessionStorage;
        }
        return ErrorMessages.photoRetrieval.notFound;
    }

    if (isPhotoStorageError(error)) {
        if (error.message.includes('quota') || error.message.includes('QuotaExceededError')) {
            return ErrorMessages.photoStorage.quotaExceeded;
        }
        return ErrorMessages.photoStorage.genericFailure;
    }

    if (isCameraAccessError(error)) {
        if (error.message.includes('Permission') || error.message.includes('permission')) {
            return ErrorMessages.cameraAccess.permissionDenied;
        }
        if (error.message.includes('device') || error.message.includes('Device')) {
            return ErrorMessages.cameraAccess.deviceNotFound;
        }
        return ErrorMessages.cameraAccess.genericFailure;
    }

    if (isEntrySubmissionError(error)) {
        if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
            return ErrorMessages.submission.validationError(error.message);
        }
        if (error.statusCode && error.statusCode >= 500) {
            return ErrorMessages.submission.serverError;
        }
        if (error.message.includes('network') || error.message.includes('fetch')) {
            return ErrorMessages.submission.networkError;
        }
        return ErrorMessages.submission.genericFailure;
    }

    // Fallback for unknown errors
    if (error instanceof Error) {
        return error.message;
    }

    return "An unexpected error occurred. Please try again.";
}

// Factory functions for creating error instances
// These follow the project's encapsulation convention

/**
 * Creates a PhotoRetrievalError instance
 * @param {string} message - Error message
 * @param {string|null} requestIdentifier - Request identifier for the photos
 * @param {Error|null} cause - Underlying cause of the error
 * @returns {PhotoRetrievalError}
 */
export function makePhotoRetrievalError(message, requestIdentifier = null, cause = null) {
    return new PhotoRetrievalError(message, requestIdentifier, cause);
}

/**
 * Creates an EntrySubmissionError instance
 * @param {string} message - Error message
 * @param {number|null} statusCode - HTTP status code if applicable
 * @param {Error|null} cause - Underlying cause of the error
 * @returns {EntrySubmissionError}
 */
export function makeEntrySubmissionError(message, statusCode = null, cause = null) {
    return new EntrySubmissionError(message, statusCode, cause);
}

/**
 * Creates a SessionStorageError instance
 * @param {string} message - Error message
 * @param {string} operation - The operation that failed
 * @param {Error|null} cause - Underlying cause of the error
 * @returns {SessionStorageError}
 */
export function makeSessionStorageError(message, operation, cause = null) {
    return new SessionStorageError(message, operation, cause);
}

/**
 * Creates a PhotoStorageError instance
 * @param {string} message - Error message
 * @param {Error|null} cause - Underlying cause of the error
 * @returns {PhotoStorageError}
 */
export function makePhotoStorageError(message, cause = null) {
    return new PhotoStorageError(message, cause);
}

/**
 * Creates a PhotoConversionError instance
 * @param {string} message - Error message
 * @param {string} conversionType - Type of conversion that failed
 * @param {Error|null} cause - Underlying cause of the error
 * @returns {PhotoConversionError}
 */
export function makePhotoConversionError(message, conversionType, cause = null) {
    return new PhotoConversionError(message, conversionType, cause);
}

