/**
 * @jest-environment jsdom
 */

import { 
    makePhotoRetrievalError,
    makeEntrySubmissionError,
    makeSessionStorageError,
    isPhotoRetrievalError,
    isEntrySubmissionError,
    isSessionStorageError,
    getUserFriendlyErrorMessage
} from '../src/DescriptionEntry/errors.js';

describe('DescriptionEntry error handling integration', () => {
    describe('Error factory functions', () => {
        test('makePhotoRetrievalError creates correct error instance', () => {
            const error = makePhotoRetrievalError('Photo retrieval failed', 'req-123');
            
            expect(isPhotoRetrievalError(error)).toBe(true);
            expect(error.message).toBe('Photo retrieval failed');
            expect(error.requestIdentifier).toBe('req-123');
            expect(error.isRecoverable).toBe(true);
        });

        test('makeEntrySubmissionError creates correct error instance', () => {
            const error = makeEntrySubmissionError('Network error', 500);
            
            expect(isEntrySubmissionError(error)).toBe(true);
            expect(error.message).toBe('Network error');
            expect(error.statusCode).toBe(500);
            expect(error.isRecoverable).toBe(true);
        });

        test('makeSessionStorageError creates correct error instance', () => {
            const error = makeSessionStorageError('Storage access denied', 'getItem');
            
            expect(isSessionStorageError(error)).toBe(true);
            expect(error.message).toBe('Storage access denied');
            expect(error.operation).toBe('getItem');
        });
    });

    describe('Error recovery classification', () => {
        test('identifies recoverable photo errors', () => {
            const recoverableError = makePhotoRetrievalError('Minor parsing error', 'req-123');
            expect(recoverableError.isRecoverable).toBe(true);
        });

        test('identifies recoverable submission errors', () => {
            const recoverableError = makeEntrySubmissionError('Network timeout', 500);
            expect(recoverableError.isRecoverable).toBe(true);
        });
    });

    describe('User-friendly error messages', () => {
        test('generates appropriate message for photo retrieval errors', () => {
            const error = makePhotoRetrievalError('Failed to convert photo', 'req-123');
            const message = getUserFriendlyErrorMessage(error);
            
            expect(message).toContain('photo');
            expect(message.length).toBeGreaterThan(10);
        });

        test('generates appropriate message for network submission errors', () => {
            const error = makeEntrySubmissionError('Network error', 500);
            const message = getUserFriendlyErrorMessage(error);
            
            expect(message).toContain('Server error'); // Update to match actual message
            expect(message.length).toBeGreaterThan(10);
        });

        test('generates appropriate message for storage errors', () => {
            const error = makeSessionStorageError('Storage quota exceeded', 'setItem');
            const message = getUserFriendlyErrorMessage(error);
            
            expect(message).toBe('Storage quota exceeded'); // Exact match for this message
            expect(message.length).toBeGreaterThan(10);
        });

        test('provides fallback message for unknown errors', () => {
            const error = new Error('Unknown error');
            const message = getUserFriendlyErrorMessage(error);
            
            expect(message).toBe('Unknown error');
        });
    });

    describe('Error type guards', () => {
        test('correctly identifies different error types', () => {
            const photoError = makePhotoRetrievalError('Photo error', 'req-123');
            const submissionError = makeEntrySubmissionError('Submission error', 400);
            const storageError = makeSessionStorageError('Storage error', 'getItem');
            const genericError = new Error('Generic error');

            expect(isPhotoRetrievalError(photoError)).toBe(true);
            expect(isPhotoRetrievalError(submissionError)).toBe(false);
            expect(isPhotoRetrievalError(genericError)).toBe(false);

            expect(isEntrySubmissionError(submissionError)).toBe(true);
            expect(isEntrySubmissionError(photoError)).toBe(false);
            expect(isEntrySubmissionError(genericError)).toBe(false);

            expect(isSessionStorageError(storageError)).toBe(true);
            expect(isSessionStorageError(photoError)).toBe(false);
            expect(isSessionStorageError(genericError)).toBe(false);
        });

        test('returns false for non-error values', () => {
            expect(isPhotoRetrievalError(null)).toBe(false);
            expect(isPhotoRetrievalError(undefined)).toBe(false);
            expect(isPhotoRetrievalError('string')).toBe(false);
            expect(isPhotoRetrievalError({})).toBe(false);
        });
    });
});
