import { API_BASE_URL } from "../api_base_url.js";
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
            return { results: parseEntries(data.results), hasMore: data.next != null };
        }

        logger.warn("Failed to search entries:", response.status);
        return { results: [], hasMore: false, error: "Failed to fetch results" };
    } catch (error) {
        logger.error("Error searching entries:", error);
        return { results: [], hasMore: false, error: "Network error" };
    }
}

/**
 * @typedef {object} AdditionalProperties
 * @property {number} [calories] - Estimated calorie count; absent when 0 or unknown.
 * @property {string} [transcription] - Transcription text; absent when unavailable.
 * @property {Object<string, string>} [errors] - Per-property error messages; absent when no errors.
 */

/**
 * @typedef {'calories' | 'transcription'} AdditionalPropertyName
 */

/**
 * @typedef {'image'|'audio'|'other'} MediaType
 */

/**
 * @typedef {object} AssetInfo
 * @property {string} filename - The filename of the asset.
 * @property {string} url - The URL path to the asset (relative to API base, e.g. "/assets/...").
 * @property {MediaType} mediaType - The media type of the asset.
 */

/**
 * Fetches computed additional properties for an entry (e.g. calories).
 * Triggers the incremental graph pull on the server side.
 * @param {string} id - The entry id.
 * @param {AdditionalPropertyName} [propertyName] - Specific property to fetch.
 * @returns {Promise<AdditionalProperties>}
 */
export async function fetchAdditionalProperties(id, propertyName) {
    try {
        const propertyParam = propertyName === undefined
            ? ""
            : `?property=${encodeURIComponent(propertyName)}`;
        const response = await fetch(
            `${API_BASE_URL}/entries/${encodeURIComponent(id)}/additional-properties${propertyParam}`,
        );

        if (response.ok) {
            const data = await response.json();
            return data;
        }

        logger.warn("Failed to fetch additional properties:", response.status);
        return {};
    } catch (error) {
        logger.error("Error fetching additional properties:", error);
        return {};
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
 * Fetches the asset files associated with an entry.
 * @param {string} id - The entry id.
 * @returns {Promise<AssetInfo[]>}
 */
export async function fetchEntryAssets(id) {
    try {
        const response = await fetch(
            `${API_BASE_URL}/entries/${encodeURIComponent(id)}/assets`,
        );

        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data.assets)) {
                return data.assets;
            }
            return [];
        }

        logger.warn("Failed to fetch entry assets:", response.status);
        return [];
    } catch (error) {
        logger.error("Error fetching entry assets:", error);
        return [];
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
