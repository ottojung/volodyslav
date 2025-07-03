import { useState, useEffect } from "react";
import { useToast } from "@chakra-ui/react";
import {
    fetchRecentEntries as apiFetchRecentEntries,
    submitEntry,
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
import {
    isPhotoRetrievalError,
    isEntrySubmissionError,
    isSessionStorageError,
    getUserFriendlyErrorMessage
} from "./errors.js";

/**
 * @typedef {object} DescriptionEntryHook
 * @property {string} description
 * @property {boolean} isSubmitting
 * @property {any[]} recentEntries
 * @property {boolean} isLoadingEntries
 * @property {string|null} pendingRequestIdentifier
 * @property {(value: string) => void} setDescription
 * @property {() => Promise<void>} handleSubmit
 * @property {() => void} handleTakePhotos
 * @property {(e: React.KeyboardEvent) => void} handleKeyUp
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
    const [recentEntries, setRecentEntries] = useState(/** @type {any[]} */ ([]));
    const [isLoadingEntries, setIsLoadingEntries] = useState(true);
    const [pendingRequestIdentifier, setPendingRequestIdentifier] = useState(/** @type {string|null} */ (null));
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

        try {
            // Retrieve photos if we have a pending request identifier
            /** @type {File[]} */
            let files = [];
            
            if (pendingRequestIdentifier) {
                try {
                    files = await retrievePhotos(pendingRequestIdentifier);
                } catch (error) {
                    logger.error("Photo retrieval error:", error);
                    
                    if (isPhotoRetrievalError(error) && error.isRecoverable) {
                        // Show warning but allow submission without photos
                        const userMessage = getUserFriendlyErrorMessage(error);
                        toast({
                            title: "Photo issue",
                            description: `${userMessage} Your entry will be submitted without photos.`,
                            status: "warning",
                            duration: 8000,
                            isClosable: true,
                        });
                        // Reset pending identifier and continue with submission
                        setPendingRequestIdentifier(null);
                    } else {
                        // Non-recoverable photo error - fail the submission
                        const userMessage = getUserFriendlyErrorMessage(error);
                        toast(createToastConfig.error(userMessage));
                        return;
                    }
                }
            }
            
            const result = await submitEntry(description.trim(), pendingRequestIdentifier || undefined, files);
            const savedInput = result.entry?.input ?? description.trim();

            setDescription("");
            setPendingRequestIdentifier(null);
            fetchRecentEntries();
            
            // Show success message with file count if applicable
            const fileCountMessage = files.length > 0 ? ` with ${files.length} photo(s)` : '';
            toast({
                ...createToastConfig.success(savedInput),
                description: `Entry logged successfully${fileCountMessage}`,
            });
        } catch (error) {
            logger.error("Entry submission error:", error);
            
            // Use specialized error handling
            if (isEntrySubmissionError(error)) {
                const userMessage = getUserFriendlyErrorMessage(error);
                toast(createToastConfig.error(userMessage));
            } else {
                // Fallback for unexpected errors
                const errorMessage = error instanceof Error 
                    ? error.message 
                    : "Please check your connection and try again.";
                toast(createToastConfig.error(errorMessage));
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleTakePhotos = () => {
        const requestIdentifier = generateRequestIdentifier();
        setPendingRequestIdentifier(requestIdentifier);
        navigateToCamera(requestIdentifier, description);
    };

    const handleKeyUp = (/** @type {any} */ e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
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
            // Restore the description that was stored before going to camera
            const restoredDescription = restoreDescription(cameraReturn.requestIdentifier);
            if (restoredDescription) {
                setDescription(restoredDescription);
            }
            
            // Set the request identifier for the next submission
            setPendingRequestIdentifier(cameraReturn.requestIdentifier);
            
            // Clean up URL parameters
            cleanupUrlParams();
            
            // Show a toast to let user know photos are ready
            try {
                const photosDataString = sessionStorage.getItem(`photos_${cameraReturn.requestIdentifier}`);
                let photoCount = 0;
                if (photosDataString) {
                    try {
                        const photosData = JSON.parse(photosDataString);
                        if (Array.isArray(photosData)) {
                            photoCount = photosData.length;
                        }
                    } catch (parseError) {
                        logger.warn('Error parsing photos data on camera return:', parseError);
                        toast({
                            title: "Photo data issue",
                            description: "There may be an issue with your photos. Please try taking new photos if needed.",
                            status: "warning",
                            duration: 6000,
                            isClosable: true,
                        });
                        return;
                    }
                }
                
                toast({
                    title: `${photoCount} photo(s) ready`,
                    description: 'Complete your description and submit to create the entry.',
                    status: 'success',
                    duration: 5000,
                    isClosable: true,
                });
            } catch (storageError) {
                logger.warn('Error accessing session storage on camera return:', storageError);
                
                // Use proper error handling for session storage errors
                if (isSessionStorageError(storageError)) {
                    const userMessage = getUserFriendlyErrorMessage(storageError);
                    toast(createToastConfig.warning(userMessage));
                } else {
                    toast({
                        title: "Storage access issue",
                        description: "Unable to verify your photos. Please check if photos are attached before submitting.",
                        status: "warning",
                        duration: 6000,
                        isClosable: true,
                    });
                }
            }
        }
    }, [toast]); // Remove description dependency to avoid running on every description change

    return {
        // State
        description,
        isSubmitting,
        recentEntries,
        isLoadingEntries,
        pendingRequestIdentifier,
        
        // Actions
        setDescription,
        handleSubmit,
        handleTakePhotos,
        handleKeyUp,
        fetchRecentEntries,
    };
};
