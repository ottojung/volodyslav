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

/**
 * Custom hook for managing description entry form state and actions
 * @param {number} numberOfEntries - Number of recent entries to fetch
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
            const files = pendingRequestIdentifier ? retrievePhotos(pendingRequestIdentifier) : [];
            
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
            logger.error("Error logging event:", error);
            const errorMessage = error instanceof Error 
                ? error.message 
                : "Please check your connection and try again.";
            toast(createToastConfig.error(errorMessage));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleTakePhotos = () => {
        const requestIdentifier = generateRequestIdentifier();
        setPendingRequestIdentifier(requestIdentifier);
        navigateToCamera(requestIdentifier, description);
    };

    const handleClear = () => {
        setDescription("");
        setPendingRequestIdentifier(null);
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
            const photosDataString = sessionStorage.getItem(`photos_${cameraReturn.requestIdentifier}`);
            let photoCount = 0;
            if (photosDataString) {
                try {
                    const photosData = JSON.parse(photosDataString);
                    photoCount = photosData.length;
                } catch (e) {
                    console.warn('Error parsing photos data:', e);
                }
            }
            
            toast({
                title: `${photoCount} photo(s) ready`,
                description: 'Complete your description and submit to create the entry.',
                status: 'success',
                duration: 5000,
                isClosable: true,
            });
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
        handleClear,
        handleKeyUp,
        fetchRecentEntries,
    };
};
