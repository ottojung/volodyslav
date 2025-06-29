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
    
    console.log("🟡 RETRIEVE DEBUG: Starting photo retrieval", {
        requestIdentifier,
        key,
    });
    
    const stored = sessionStorage.getItem(key);
    
    console.log("🟡 RETRIEVE DEBUG: SessionStorage lookup", {
        key,
        found: !!stored,
        dataSize: stored ? stored.length : 0,
        firstChars: stored ? stored.substring(0, 100) + '...' : null,
    });
    
    if (!stored) {
        console.log("🟡 RETRIEVE DEBUG: No photos found in sessionStorage");
        return [];
    }
    
    try {
        const photosData = JSON.parse(stored);
        
        console.log("🟡 RETRIEVE DEBUG: Parsed photos data", {
            photoCount: photosData.length,
            photoNames: photosData.map(/** @param {{name: string, data: string, type: string}} p */ p => p.name),
            photoSizes: photosData.map(/** @param {{name: string, data: string, type: string}} p */ p => p.data.length),
        });
        
        const files = await Promise.all(photosData.map(async (/** @type {{name: string, data: string, type: string}} */ photo) => {
            console.log("🟡 RETRIEVE DEBUG: Converting photo to File", {
                name: photo.name,
                type: photo.type,
                base64Size: photo.data.length,
            });
            
            // Convert base64 back to blob, then to File
            // Create a data URL and fetch it to get the blob
            const dataUrl = `data:${photo.type};base64,${photo.data}`;
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            
            // Create File object from blob
            const file = new File([blob], photo.name, { type: photo.type });
            
            console.log("🟡 RETRIEVE DEBUG: Created File object", {
                name: file.name,
                size: file.size,
                type: file.type,
            });
            
            return file;
        }));
        
        console.log("🟡 RETRIEVE DEBUG: All files converted", {
            fileCount: files.length,
            totalSize: files.reduce(/** @param {number} sum @param {File} f */ (sum, f) => sum + f.size, 0),
        });
        
        // Clean up the stored photos
        sessionStorage.removeItem(key);
        
        console.log("🟡 RETRIEVE DEBUG: Cleaned up sessionStorage");
        
        return files;
    } catch (error) {
        console.error('🔴 RETRIEVE DEBUG: Error retrieving photos:', error);
        sessionStorage.removeItem(key);
        return [];
    }
};
