import { useState, useEffect } from "react";
import { useToast } from "@chakra-ui/react";
import {
    fetchRecentEntries as apiFetchRecentEntries,
    submitEntry,
    deleteEntry as apiDeleteEntry,
} from "./api";
import { isValidDescription, createToastConfig } from "./utils.js";
import { logger } from "./logger.js";
import {
    generateRequestIdentifier,
    navigateToCamera,
    checkCameraReturn,
    cleanupUrlParams,
    restoreDescription,
    retrievePhotos
} from "./cameraUtils.js";
import { retrievePhotos as getStoredPhotosFromIndexedDB } from "./photoStorage.js";
import {
    isPhotoRetrievalError,
    isEntrySubmissionError,
    getUserFriendlyErrorMessage
} from "./errors.js";

/**
 * Handles photo retrieval and error cases
 * @param {string} pendingRequestIdentifier - The request identifier for photos
 * @param {Function} toast - Toast notification function
 * @param {Function} setPendingRequestIdentifier - State setter function
 * @returns {Promise<File[]>} - Array of retrieved files
 */
const handlePhotoRetrieval = async (pendingRequestIdentifier, toast, setPendingRequestIdentifier) => {
    try {
        return await retrievePhotos(pendingRequestIdentifier);
    } catch (error) {
        logger.error("Photo retrieval error:", error);
        const userMessage = getUserFriendlyErrorMessage(error);

        if (isPhotoRetrievalError(error) && error.isRecoverable) {
            toast({
                title: "Photo issue",
                description: `${userMessage} Your entry will be submitted without photos.`,
                status: "warning",
                duration: 8000,
                isClosable: true,
                position: "bottom",
            });
            setPendingRequestIdentifier(null);
            return [];
        } else {
            toast(createToastConfig.error(userMessage));
            throw error;
        }
    }
};

/**
 * Handles submission success actions
 * @param {any} result - Submission result
 * @param {string} description - The description that was submitted
 * @param {File[]} files - Files to submit
 * @param {Function} setPendingRequestIdentifier - State setter
 * @param {Function} setPhotoCount - State setter for photo count
 * @param {Function} fetchRecentEntries - Function to refresh entries
 * @param {Function} toast - Toast notification function
 */
const handleSubmissionSuccess = (result, description, files, setPendingRequestIdentifier, setPhotoCount, fetchRecentEntries, toast) => {
    const savedInput = result.entry?.input ?? description.trim();
    setPendingRequestIdentifier(null);
    setPhotoCount(0);
    fetchRecentEntries();

    const fileCountMessage = files.length > 0 ? ` with ${files.length} photo(s)` : '';
    toast({
        ...createToastConfig.success(savedInput),
        description: `Entry logged successfully${fileCountMessage}`,
    });
};

/**
 * Handles submission errors
 * @param {unknown} error - The error that occurred
 * @param {Function} toast - Toast notification function
 */
const handleSubmissionError = (error, toast) => {
    logger.error("Entry submission error:", error);

    if (isEntrySubmissionError(error)) {
        toast(createToastConfig.error(getUserFriendlyErrorMessage(error)));
    } else {
        const errorMessage = error instanceof Error
            ? error.message
            : "Please check your connection and try again.";
        toast(createToastConfig.error(errorMessage));
    }
};

/**
 * Gets photo count from IndexedDB storage
 * @param {string} requestIdentifier - The request identifier
 * @param {Function} toast - Toast notification function
 * @returns {Promise<number>} - Number of photos found
 */
const getPhotoCountFromStorage = async (requestIdentifier, toast) => {
    try {
        const photosData = await getStoredPhotosFromIndexedDB(`photos_${requestIdentifier}`);
        return Array.isArray(photosData) ? photosData.length : 0;
    } catch (photoError) {
        logger.warn('Error retrieving photos data on camera return:', photoError);
        toast({
            title: "Photo data issue",
            description: "There may be an issue with your photos. Please check if photos are attached before submitting.",
            status: "warning",
            duration: 6000,
            isClosable: true,
            position: "bottom",
        });
        return 0;
    }
};

/**
 * Handles camera return processing
 * @param {any} cameraReturn - Camera return data
 * @param {Function} setDescription - State setter
 * @param {Function} setPendingRequestIdentifier - State setter
 * @param {Function} setPhotoCount - State setter for photo count
 * @param {Function} toast - Toast notification function
 */
const processCameraReturn = async (cameraReturn, setDescription, setPendingRequestIdentifier, setPhotoCount, toast) => {
    const restoredDescription = restoreDescription(cameraReturn.requestIdentifier);
    if (restoredDescription) {
        setDescription(restoredDescription);
    }

    setPendingRequestIdentifier(cameraReturn.requestIdentifier);
    cleanupUrlParams();

    const count = await getPhotoCountFromStorage(cameraReturn.requestIdentifier, toast);
    setPhotoCount(count);
    
    const photoText = count === 1 ? 'photo' : 'photos';
    toast({
        title: `${count} ${photoText} ready`,
        description: 'Complete your description and submit to create the entry.',
        status: 'success',
        duration: 5000,
        isClosable: true,
        position: "bottom",
    });
};

/**
 * @typedef {object} DescriptionEntryHook
 * @property {string} description
 * @property {boolean} isSubmitting
 * @property {any[]} recentEntries
 * @property {boolean} isLoadingEntries
 * @property {string|null} pendingRequestIdentifier
 * @property {number} photoCount
 * @property {(value: string) => void} setDescription
 * @property {() => Promise<void>} handleSubmit
 * @property {() => void} handleTakePhotos
 * @property {(e: React.KeyboardEvent) => void} handleKeyUp
 * @property {(id: string) => Promise<void>} handleDeleteEntry
 * @property {() => Promise<void>} fetchRecentEntries
 */

/**
 * Custom hook for managing description entry form state and actions
 * @param {number} numberOfEntries - Number of recent entries to fetch
 * @returns {DescriptionEntryHook}
 */
export const useDescriptionEntry = (numberOfEntries = 10) => {
    const [description, setDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    /** @type {[any[], import("react").Dispatch<import("react").SetStateAction<any[]>>]} */
    const [recentEntries, setRecentEntries] = useState([]);
    const [isLoadingEntries, setIsLoadingEntries] = useState(true);
    /** @type {[string|null, import("react").Dispatch<import("react").SetStateAction<string|null>>]} */
    const [pendingRequestIdentifier, setPendingRequestIdentifier] = useState(null);
    const [photoCount, setPhotoCount] = useState(0);
    const toast = useToast();

    const fetchRecentEntries = async () => {
        try {
            setIsLoadingEntries(true);
            const entries = await apiFetchRecentEntries(numberOfEntries);
            setRecentEntries(entries);
        } catch (error) {
            logger.error("Error fetching recent entries:", error);
        } finally {
            setIsLoadingEntries(false);
        }
    };

    const handleSubmit = async () => {
        if (!isValidDescription(description)) {
            toast(createToastConfig.emptyDescription());
            return;
        }

        setIsSubmitting(true);
        
        // Capture the description value before clearing it
        const descriptionToSubmit = description.trim();
        // Clear the description immediately to prevent duplicate submissions
        setDescription("");

        try {
            /** @type {File[]} */
            let files = [];
            if (pendingRequestIdentifier) {
                try {
                    files = await handlePhotoRetrieval(pendingRequestIdentifier, toast, setPendingRequestIdentifier);
                } catch (error) {
                    // Restore description on photo retrieval error
                    setDescription(descriptionToSubmit);
                    return;
                }
            }

            const result = await submitEntry(descriptionToSubmit, pendingRequestIdentifier || undefined, files);
            handleSubmissionSuccess(result, descriptionToSubmit, files, setPendingRequestIdentifier, setPhotoCount, fetchRecentEntries, toast);
        } catch (error) {
            handleSubmissionError(error, toast);
            // Restore description on submission error
            setDescription(descriptionToSubmit);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleTakePhotos = () => {
        const requestIdentifier = generateRequestIdentifier();
        setPendingRequestIdentifier(requestIdentifier);
        navigateToCamera(requestIdentifier, description);
    };

    /**
     * @param {React.KeyboardEvent} e
     */
    const handleKeyUp = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!isSubmitting) {
                handleSubmit();
            }
        }
    };

    /**
     * Deletes an entry and refreshes list.
     * @param {string} id
     * @returns {Promise<void>}
     */
    const handleDeleteEntry = async (id) => {
        try {
            const success = await apiDeleteEntry(id);
            if (success) {
                fetchRecentEntries();
            } else {
                toast(createToastConfig.error("Failed to delete entry"));
            }
        } catch (error) {
            logger.error("Error deleting entry:", error);
            toast(createToastConfig.error("Failed to delete entry"));
        }
    };

    // Fetch entries on mount
    useEffect(() => {
        fetchRecentEntries();
    }, []);

    // Handle return from camera
    useEffect(() => {
        const cameraReturn = checkCameraReturn();
        if (cameraReturn.isReturn && cameraReturn.requestIdentifier) {
            processCameraReturn(cameraReturn, setDescription, setPendingRequestIdentifier, setPhotoCount, toast);
        }
    }, [toast]);

    return {
        // State
        description,
        isSubmitting,
        recentEntries,
        isLoadingEntries,
        pendingRequestIdentifier,
        photoCount,

        // Actions
        setDescription,
        handleSubmit,
        handleTakePhotos,
        handleKeyUp,
        handleDeleteEntry,
        fetchRecentEntries,
    };
};
