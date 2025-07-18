/**
 * Camera integration utilities for DescriptionEntry (aggregated exports)
 */

import {
    makePhotoRetrievalError,
    makePhotoConversionError,
    makeSessionStorageError,
    isPhotoRetrievalError,
    isPhotoConversionError,
} from './errors.js';
import { logger } from './logger.js';
import { retrievePhotos as getStoredPhotos, removePhotos as deleteStoredPhotos } from './photoStorage.js';

/**
 * Generates a unique request identifier for camera sessions
 * @returns {string} - A unique identifier
 */
export const generateRequestIdentifier = () => {
    return `camera_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};
/**
 * Navigates to the camera page with a request identifier
 * @param {string} requestIdentifier - The unique request identifier
 * @param {string} currentDescription - The current description to preserve
 */
export const navigateToCamera = (requestIdentifier, currentDescription = '') => {
    // Store the current description in sessionStorage to restore it later
    if (currentDescription.trim()) {
        sessionStorage.setItem(`description_${requestIdentifier}`, currentDescription);
    }
    
    const url = new URL('/camera', window.location.origin);
    url.searchParams.set('request_identifier', requestIdentifier);
    url.searchParams.set('return_to', '/describe');
    window.location.href = url.toString();
};

/**
 * Checks if the current URL indicates a return from camera
 * @returns {{isReturn: boolean, requestIdentifier?: string}} - Return info
 */
export const checkCameraReturn = () => {
    const params = new URLSearchParams(window.location.search);
    const fromCamera = params.get('from_camera');
    const requestIdentifier = params.get('request_identifier');
    
    return {
        isReturn: fromCamera === 'true' && !!requestIdentifier,
        requestIdentifier: requestIdentifier || undefined
    };
};

/**
 * Cleans up camera-related URL parameters
 */
export const cleanupUrlParams = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('from_camera');
    url.searchParams.delete('request_identifier');
    window.history.replaceState({}, '', url.toString());
};

/**
 * Restores the description from sessionStorage after returning from camera
 * @param {string} requestIdentifier - The request identifier
 * @returns {string|null} - The restored description or null if not found
 */
export const restoreDescription = (requestIdentifier) => {
    const key = `description_${requestIdentifier}`;
    const stored = sessionStorage.getItem(key);
    if (stored) {
        // Clean up the stored description
        sessionStorage.removeItem(key);
        return stored;
    }
    return null;
};

/**
 * Retrieves photos from IndexedDB and converts them back to File objects
 * @param {string} requestIdentifier - The request identifier
 * @returns {Promise<File[]>} - Array of File objects, or empty array if not found
 * @throws {PhotoRetrievalError} When photo retrieval fails
 */
export const retrievePhotos = async (requestIdentifier) => {
    const key = `photos_${requestIdentifier}`;
    
    if (!requestIdentifier?.trim()) {
        throw makePhotoRetrievalError(
            "Invalid request identifier provided",
            requestIdentifier
        );
    }
    
    let photosData;
    try {
        photosData = await getStoredPhotos(key);
    } catch (/** @type {unknown} */ error) {
        throw makePhotoRetrievalError(
            "Failed to access stored photos",
            requestIdentifier,
            error instanceof Error ? error : new Error(String(error))
        );
    }
    
    if (!photosData) {
        // This is not an error - no photos were stored for this session
        return [];
    }
    
    if (!Array.isArray(photosData)) {
        throw makePhotoRetrievalError(
            "Stored photo data is not in expected format",
            requestIdentifier
        );
    }
    
    if (photosData.length === 0) {
        return [];
    }
    
    try {
        const files = await Promise.all(photosData.map(async (/** @type {{name: string, data: string, type: string}} */ photo, index) => {
            // Validate photo data structure
            validatePhotoData(photo, index);
            
            try {
                // Convert base64 back to blob, then to File
                // Create a data URL and fetch it to get the blob
                const dataUrl = `data:${photo.type};base64,${photo.data}`;
                const response = await fetch(dataUrl);
                
                if (!response.ok) {
                    throw makePhotoConversionError(
                        `Failed to decode photo data for ${photo.name}`,
                        photo.name
                    );
                }
                
                const blob = await response.blob();
                
                if (blob.size === 0) {
                    throw makePhotoConversionError(
                        `Photo ${photo.name} appears to be empty or corrupted`,
                        photo.name
                    );
                }
                
                // Create File object from blob
                const file = new File([blob], photo.name, { type: photo.type });
                
                return file;
            } catch (/** @type {unknown} */ error) {
                if (isPhotoConversionError(error)) {
                    throw error;
                }
                throw makePhotoConversionError(
                    `Failed to convert photo ${photo.name} to file`,
                    photo.name,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }));
        
        // Clean up the stored photos only after successful conversion
        try {
            await deleteStoredPhotos(key);
        } catch (/** @type {unknown} */ error) {
            // Log but don't fail - photos were successfully retrieved
            logger.warn('Failed to clean up stored photos:', error);
        }
        
        return files;
    } catch (/** @type {unknown} */ error) {
        // If it's already one of our custom errors, re-throw it
        if (isPhotoRetrievalError(error) || isPhotoConversionError(error)) {
            throw error;
        }
        
        // For any other unexpected errors
        throw makePhotoRetrievalError(
            "Unexpected error occurred while processing photos",
            requestIdentifier,
            error instanceof Error ? error : new Error(String(error))
        );
    }
};

/**
 * Safe sessionStorage operations that handle errors gracefully
 */

/**
 * Safely gets an item from sessionStorage
 * @param {string} key - The storage key
 * @returns {string|null} - The stored value or null if not found/error
 * @throws {SessionStorageError} When storage access fails
 */
export const safeSessionStorageGet = (key) => {
    try {
        return sessionStorage.getItem(key);
    } catch (/** @type {unknown} */ error) {
        throw makeSessionStorageError(
            `Failed to read from session storage (key: ${key})`,
            'get',
            error instanceof Error ? error : new Error(String(error))
        );
    }
};
/**
 * Safely sets an item in sessionStorage
 * @param {string} key - The storage key
 * @param {string} value - The value to store
 * @throws {SessionStorageError} When storage operation fails
 */
export const safeSessionStorageSet = (key, value) => {
    try {
        sessionStorage.setItem(key, value);
    } catch (/** @type {unknown} */ error) {
        // Check if it's a quota exceeded error
        const isQuotaError = error instanceof Error && 
            (error.name === 'QuotaExceededError' || 
             error.message.includes('quota') || 
             error.message.includes('storage'));
             
        throw makeSessionStorageError(
            isQuotaError
                ? `Storage quota exceeded. Please free up space and try again.`
                : `Failed to save to session storage (key: ${key})`,
            'set',
            error instanceof Error ? error : new Error(String(error))
        );
    }
};

/**
 * Safely removes an item from sessionStorage
 * @param {string} key - The storage key
 * @throws {SessionStorageError} When storage operation fails
 */
export const safeSessionStorageRemove = (key) => {
    try {
        sessionStorage.removeItem(key);
    } catch (/** @type {unknown} */ error) {
        throw makeSessionStorageError(
            `Failed to remove from session storage (key: ${key})`,
            'remove',
            error instanceof Error ? error : new Error(String(error))
        );
    }
};

/**
 * Validates photo data structure
 * @param {unknown} photoData - The photo data to validate
 * @param {number} index - Index of the photo for error reporting
 * @returns {photoData is {name: string, data: string, type: string}} - Type guard
 * @throws {PhotoConversionError} When photo data is invalid
 */
export const validatePhotoData = (photoData, index) => {
    if (!photoData || typeof photoData !== 'object') {
        throw makePhotoConversionError(
            `Photo ${index + 1} is not a valid object`,
            `photo_${index + 1}`
        );
    }

    if (!('name' in photoData) || typeof photoData.name !== 'string') {
        throw makePhotoConversionError(
            `Photo ${index + 1} has invalid or missing name`,
            'name' in photoData && typeof photoData.name === 'string'
                ? photoData.name
                : `photo_${index + 1}`
        );
    }

    if (!('data' in photoData) || typeof photoData.data !== 'string') {
        throw makePhotoConversionError(
            `Photo ${photoData.name} has invalid or missing data`,
            photoData.name
        );
    }

    if (!('type' in photoData) || typeof photoData.type !== 'string') {
        throw makePhotoConversionError(
            `Photo ${photoData.name} has invalid or missing type`,
            photoData.name
        );
    }
    // Validate that it looks like a base64 string
    if (!/^[A-Za-z0-9+/]+=*$/.test(photoData.data)) {
        throw makePhotoConversionError(
            `Photo ${photoData.name} has invalid base64 data`,
            photoData.name
        );
    }
    return true;
};
