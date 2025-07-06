const API_BASE_URL = "/api";
import { logger } from "./logger.js";
import { EntrySubmissionError } from "./errors.js";

/**
 * @typedef {Object} Entry
 * @property {string} id - Unique identifier for the entry
 * @property {string} date - ISO date string
 * @property {string} type - Type of the entry
 * @property {string} description - Description of the entry
 * @property {string} input - Processed input
 * @property {string} original - Original input
 * @property {Object} modifiers - Entry modifiers
 * @property {Object} creator - Entry creator info
 */

/**
 * @typedef {[string, string] | [string, string, string]} Shortcut
 * A tuple representing a shortcut:
 * - [0]: pattern - Regex pattern to match
 * - [1]: replacement - Replacement string  
 * - [2]: description - Optional description
 */

/**
 * @typedef {Object} Config
 * @property {string} help - Help text for the configuration
 * @property {Shortcut[]} shortcuts - Array of shortcuts
 */

/**
 * Type guard for Entry objects.
 * @param {any} value
 * @returns {value is Entry}
 */
function isEntry(value) {
    return (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.id === "string" &&
        typeof value.date === "string" &&
        typeof value.type === "string" &&
        typeof value.description === "string" &&
        typeof value.input === "string" &&
        typeof value.original === "string" &&
        typeof value.creator === "object"
    );
}

/**
 * Safely parses an array of unknown values into Entry objects.
 * @param {unknown} results
 * @returns {Entry[]}
 */
function parseEntries(results) {
    if (!Array.isArray(results)) return [];
    /** @type {Entry[]} */
    const valid = [];
    for (const item of results) {
        if (isEntry(item)) {
            valid.push(item);
        }
    }
    return valid;
}

/**
 * Fetches recent entries from the API.
 * @param {number} [limit=10] - The maximum number of entries to fetch.
 * @returns {Promise<Entry[]>} - Array of recent entries, or empty array if fetch fails.
 */
export const fetchRecentEntries = async (limit = 10) => {
    const response = await fetch(`${API_BASE_URL}/entries?limit=${limit}&order=dateDescending`);

    if (response.ok) {
        const data = await response.json();
        return parseEntries(data.results);
    } else {
        logger.warn("Failed to fetch recent entries:", response.status);
        return [];
    }
};

/**
 * Submits a new entry to the API.
 * @param {string} rawInput - The raw input description for the entry.
 * @param {string} [requestIdentifier] - Optional request identifier for associated photos.
 * @param {File[]} [files] - Optional array of files to upload with the entry.
 * @returns {Promise<{success: boolean, entry?: Entry, error?: string}>} - The API response object containing success status and entry data.
 * @throws {Error} - Throws an error if the submission fails.
 */
export async function submitEntry(rawInput, requestIdentifier = undefined, files = []) {
    let url = `${API_BASE_URL}/entries`;
    if (requestIdentifier) {
        url += `?request_identifier=${encodeURIComponent(requestIdentifier)}`;
    }

    let response;
    
    try {
        if (files && files.length > 0) {
            // If we have files, use FormData
            const formData = new FormData();
            formData.append('rawInput', rawInput);
            files.forEach(file => {
                formData.append('files', file);  // Changed from 'photos' to 'files' to match backend expectation
            });
            
            response = await fetch(url, {
                method: "POST",
                body: formData,
            });
        } else {
            // No files, use JSON
            const requestBody = { rawInput };
            
            response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(requestBody),
            });
        }
    } catch (error) {
        // Network or fetch-level errors
        if (error instanceof TypeError && error.message.includes('fetch')) {
            throw new EntrySubmissionError(
                "Unable to reach the server. Please check your internet connection.",
                null,
                error
            );
        }
        throw new EntrySubmissionError(
            "An unexpected error occurred during submission.",
            null,
            error instanceof Error ? error : new Error(String(error))
        );
    }

    if (response.status === 201) {
        try {
            const result = await response.json();
            if (result.success) {
                return result;
            } else {
                throw new EntrySubmissionError(
                    result.error || "API returned unsuccessful response",
                    response.status
                );
            }
        } catch (parseError) {
            if (parseError instanceof EntrySubmissionError) {
                throw parseError;
            }
            throw new EntrySubmissionError(
                "Unable to parse server response",
                response.status,
                parseError instanceof Error ? parseError : new Error(String(parseError))
            );
        }
    } else {
        let errorMessage = `Server error (${response.status})`;
        
        try {
            const errorData = await response.json();
            errorMessage = errorData.error || errorMessage;
        } catch {
            errorMessage = `HTTP ${response.status} ${response.statusText}`;
        }
        
        throw new EntrySubmissionError(errorMessage, response.status);
    }
}

/**
 * Fetches the current configuration from the API.
 * @returns {Promise<Config|null>} - The configuration object, or null if not found.
 */
export const fetchConfig = async () => {
    try {
        const response = await fetch(`${API_BASE_URL}/config`);

        if (response.ok) {
            const data = await response.json();
            return data.config;
        } else {
            logger.warn("Failed to fetch config:", response.status);
            return null;
        }
    } catch (error) {
        logger.error("Error fetching config:", error);
        return null;
    }
};

/**
 * Deletes an entry by id via the API.
 * @param {string} id - Entry identifier to delete.
 * @returns {Promise<boolean>} - True on success, false otherwise.
 */
export const deleteEntry = async (id) => {
    try {
        const response = await fetch(
            `${API_BASE_URL}/entries?id=${encodeURIComponent(id)}`,
            { method: "DELETE" }
        );
        if (response.ok) {
            return true;
        }
        logger.warn("Failed to delete entry:", response.status);
        return false;
    } catch (error) {
        logger.error("Error deleting entry:", error);
        return false;
    }
};
