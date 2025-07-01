/**
 * Camera integration utilities for DescriptionEntry (aggregated exports)
 */

export {
    generateRequestIdentifier,
    navigateToCamera,
    checkCameraReturn,
    cleanupUrlParams,
    restoreDescription,
} from './camera_navigation.js';

export {
    retrievePhotos,
    safeSessionStorageGet,
    safeSessionStorageSet,
    safeSessionStorageRemove,
    validatePhotoData,
} from './photo_storage.js';
