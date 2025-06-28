/**
 * Camera integration utilities for DescriptionEntry
 */

/**
 * The pattern that triggers camera functionality, matching the CLI script
 */
export const TAKE_PHOTO_CONSTANT = "[phone_take_photo]";

/**
 * Generates a unique request identifier for camera sessions
 * @returns {string} - A unique identifier
 */
export const generateRequestIdentifier = () => {
    return `camera_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Checks if the description contains the camera trigger pattern
 * @param {string} description - The user's description text
 * @returns {boolean} - True if camera is required
 */
export const requiresCamera = (description) => {
    return description.includes(TAKE_PHOTO_CONSTANT);
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
