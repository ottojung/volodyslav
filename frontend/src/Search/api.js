const API_BASE_URL = "/api";
import { logger } from "../DescriptionEntry/logger.js";
import { makeEntry } from "../DescriptionEntry/entry.js";

/**
 * @typedef {import('../DescriptionEntry/entry.js').Entry} Entry
 */

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
        try {
            const entry = makeEntry(item);
            valid.push(entry);
        } catch (error) {
            logger.warn("Invalid entry received:", error);
        }
    }
    return valid;
}

/**
 * Searches entries using a regex pattern.
 * @param {string} pattern - The regex pattern to search for.
 * @param {number} [page=1] - Page number (1-based).
 * @param {number} [limit=50] - Maximum number of results per page.
 * @returns {Promise<{results: Entry[], hasMore: boolean, error?: string}>}
 */
export async function searchEntries(pattern, page = 1, limit = 50) {
    try {
        const searchParam = pattern.trim() !== "" ? `&search=${encodeURIComponent(pattern)}` : "";
        const url = `${API_BASE_URL}/entries?page=${page}&limit=${limit}&order=dateDescending${searchParam}`;
        const response = await fetch(url);

        if (response.status === 400) {
            const data = await response.json();
            return { results: [], hasMore: false, error: data.error || "Invalid search pattern" };
        }

        if (response.ok) {
            const data = await response.json();
            return { results: parseEntries(data.results), hasMore: data.next !== null };
        }

        logger.warn("Failed to search entries:", response.status);
        return { results: [], hasMore: false, error: "Failed to fetch results" };
    } catch (error) {
        logger.error("Error searching entries:", error);
        return { results: [], hasMore: false, error: "Network error" };
    }
}

/**
 * Fetches a single entry by its id.
 * @param {string} id - The entry id.
 * @returns {Promise<Entry|null>}
 */
export async function fetchEntryById(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/entries/${encodeURIComponent(id)}`);

        if (response.ok) {
            const data = await response.json();
            return makeEntry(data.entry);
        }

        logger.warn("Failed to fetch entry by id:", response.status);
        return null;
    } catch (error) {
        logger.error("Error fetching entry by id:", error);
        return null;
    }
}

/**
 * Deletes an entry by its id.
 * @param {string} id - The entry id.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function deleteEntryById(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/entries?id=${encodeURIComponent(id)}`, {
            method: "DELETE",
        });

        if (response.ok) {
            return true;
        }

        logger.warn("Failed to delete entry:", response.status);
        return false;
    } catch (error) {
        logger.error("Error deleting entry:", error);
        return false;
    }
}
