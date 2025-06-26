import { useState, useEffect } from "react";
import { useToast } from "@chakra-ui/react";
import {
    fetchRecentEntries as apiFetchRecentEntries,
    submitEntry,
} from "./api";
import { isValidDescription, createToastConfig } from "./utils.js";
import { logger } from "./logger.js";

/**
 * Custom hook for managing description entry form state and actions
 * @param {number} numberOfEntries - Number of recent entries to fetch
 */
export const useDescriptionEntry = (numberOfEntries = 10) => {
    const [description, setDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [recentEntries, setRecentEntries] = useState(/** @type {any[]} */ ([]));
    const [isLoadingEntries, setIsLoadingEntries] = useState(true);
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
            const result = await submitEntry(description.trim());
            const savedInput = result.entry?.input ?? description.trim();

            setDescription("");
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

    return {
        // State
        description,
        isSubmitting,
        recentEntries,
        isLoadingEntries,
        
        // Actions
        setDescription,
        handleSubmit,
        handleClear,
        handleKeyUp,
        fetchRecentEntries,
    };
};
