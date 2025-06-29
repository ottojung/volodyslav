/**
 * Camera integration utilities for DescriptionEntry
 */

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
 * Retrieves photos from sessionStorage and converts them back to File objects
 * @param {string} requestIdentifier - The request identifier
 * @returns {Promise<File[]>} - Array of File objects, or empty array if not found
 */
export const retrievePhotos = async (requestIdentifier) => {
    const key = `photos_${requestIdentifier}`;
    const stored = sessionStorage.getItem(key);
    if (!stored) {
        return [];
    }
    
    try {
        const photosData = JSON.parse(stored);
        
        const files = await Promise.all(photosData.map(async (/** @type {{name: string, data: string, type: string}} */ photo) => {
            // Convert base64 back to blob, then to File
            // Create a data URL and fetch it to get the blob
            const dataUrl = `data:${photo.type};base64,${photo.data}`;
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            
            // Create File object from blob
            const file = new File([blob], photo.name, { type: photo.type });
            
            return file;
        }));
        
        // Clean up the stored photos
        sessionStorage.removeItem(key);
        return files;
    } catch (error) {
        console.error('Error retrieving photos:', error);
        sessionStorage.removeItem(key);
        return [];
    }
};
