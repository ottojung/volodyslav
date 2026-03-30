import { API_BASE_URL } from "../api_base_url.js";
import { logger } from "../DescriptionEntry/logger.js";

/**
 * @typedef {object} DiarySummaryData
 * @property {string} type
 * @property {string} markdown
 * @property {string} summaryDate
 * @property {Record<string, string>} processedTranscriptions
 * @property {string} updatedAt
 * @property {string} model
 * @property {string} version
 */

/**
 * Fetches the current diary summary from the server.
 * @returns {Promise<DiarySummaryData | null>}
 */
export async function fetchDiarySummary() {
    try {
        const response = await fetch(`${API_BASE_URL}/diary-summary`);
        if (response.ok) {
            const data = await response.json();
            return data;
        }
        logger.warn("Failed to fetch diary summary:", response.status);
        return null;
    } catch (error) {
        logger.error("Error fetching diary summary:", error);
        return null;
    }
}

/**
 * Triggers the diary summary pipeline and returns the updated summary.
 * @returns {Promise<DiarySummaryData | null>}
 */
export async function runDiarySummary() {
    try {
        const response = await fetch(`${API_BASE_URL}/diary-summary/run`, {
            method: "POST",
        });
        if (response.ok) {
            const data = await response.json();
            return data;
        }
        logger.warn("Failed to run diary summary:", response.status);
        return null;
    } catch (error) {
        logger.error("Error running diary summary:", error);
        return null;
    }
}
