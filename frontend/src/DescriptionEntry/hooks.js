import { useState, useEffect } from "react";
import { useToast } from "@chakra-ui/react";
import {
    fetchRecentEntries as apiFetchRecentEntries,
    submitEntry,
} from "./api";
import { isValidDescription, createToastConfig } from "./utils.js";
import { logger } from "./logger.js";
import { 
    requiresCamera, 
    generateRequestIdentifier, 
    navigateToCamera, 
    checkCameraReturn, 
    cleanupUrlParams
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

        // Check if camera is required
        if (requiresCamera(description)) {
            const requestIdentifier = generateRequestIdentifier();
            setPendingRequestIdentifier(requestIdentifier);
            navigateToCamera(requestIdentifier);
            return;
        }

        setIsSubmitting(true);

        try {
            const result = pendingRequestIdentifier 
                ? await submitEntry(description.trim(), pendingRequestIdentifier)
                : await submitEntry(description.trim());
            const savedInput = result.entry?.input ?? description.trim();

            setDescription("");
            setPendingRequestIdentifier(null);
            fetchRecentEntries();
            toast(createToastConfig.success(savedInput));
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
            // Set the request identifier for the next submission
            setPendingRequestIdentifier(cameraReturn.requestIdentifier);
            
            // Clean up URL parameters
            cleanupUrlParams();
            
            // Show a toast to let user know photos are ready
            toast({
                title: 'Photos uploaded successfully',
                description: 'Complete your description and submit to create the entry.',
                status: 'success',
                duration: 5000,
                isClosable: true,
            });
        }
    }, [description, toast]);

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
        handleClear,
        handleKeyUp,
        fetchRecentEntries,
    };
};
