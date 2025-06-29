/**
 * @jest-environment jsdom
 */

import {
    PhotoRetrievalError,
    EntrySubmissionError,
    getUserFriendlyErrorMessage,
    isPhotoRetrievalError,
    isEntrySubmissionError
} from '../src/DescriptionEntry/errors.js';

describe('Error Handling System', () => {
    describe('Error Classes', () => {
        it('creates PhotoRetrievalError with correct properties', () => {
            const error = new PhotoRetrievalError(
                'Photo data corrupted',
                'test-request-id'
            );
            
            expect(error.message).toBe('Photo data corrupted');
            expect(error.requestIdentifier).toBe('test-request-id');
            expect(error.isRecoverable).toBe(true);
            expect(error.name).toBe('PhotoRetrievalError');
            expect(isPhotoRetrievalError(error)).toBe(true);
        });

        it('creates EntrySubmissionError with correct properties', () => {
            const error = new EntrySubmissionError(
                'Server error',
                500
            );
            
            expect(error.message).toBe('Server error');
            expect(error.statusCode).toBe(500);
            expect(error.isRecoverable).toBe(true);
            expect(error.name).toBe('EntrySubmissionError');
            expect(isEntrySubmissionError(error)).toBe(true);
        });
    });

    describe('Error Message Generation', () => {
        it('generates appropriate message for photo retrieval errors', () => {
            const error = new PhotoRetrievalError('JSON parse failed');
            const message = getUserFriendlyErrorMessage(error);
            expect(message).toContain('corrupted');
        });

        it('generates appropriate message for network errors', () => {
            const error = new EntrySubmissionError('fetch failed');
            const message = getUserFriendlyErrorMessage(error);
            expect(message).toContain('Network');
        });

        it('generates appropriate message for validation errors', () => {
            const error = new EntrySubmissionError('Invalid input', 400);
            const message = getUserFriendlyErrorMessage(error);
            expect(message).toContain('Invalid data');
        });

        it('handles unknown errors gracefully', () => {
            const error = new Error('Unknown error');
            const message = getUserFriendlyErrorMessage(error);
            expect(message).toBe('Unknown error');
        });
    });

    describe('Type Guards', () => {
        it('correctly identifies PhotoRetrievalError', () => {
            const error = new PhotoRetrievalError('test');
            expect(isPhotoRetrievalError(error)).toBe(true);
            expect(isEntrySubmissionError(error)).toBe(false);
        });

        it('correctly identifies EntrySubmissionError', () => {
            const error = new EntrySubmissionError('test');
            expect(isEntrySubmissionError(error)).toBe(true);
            expect(isPhotoRetrievalError(error)).toBe(false);
        });

        it('returns false for regular errors', () => {
            const error = new Error('regular error');
            expect(isPhotoRetrievalError(error)).toBe(false);
            expect(isEntrySubmissionError(error)).toBe(false);
        });

        it('returns false for non-error values', () => {
            expect(isPhotoRetrievalError('string')).toBe(false);
            expect(isEntrySubmissionError(null)).toBe(false);
            expect(isPhotoRetrievalError(undefined)).toBe(false);
        });
    });
});
