import { API_BASE_URL } from "./api_base_url.js";
import { logger } from "./DescriptionEntry/logger.js";

/**
 * Fetches the current Volodyslav version.
 * @returns {Promise<string|null>}
 */
export async function fetchVersion() {
    try {
        const response = await fetch(`${API_BASE_URL}/version`);

        if (!response.ok) {
            logger.warn("Failed to fetch version:", response.status);
            return null;
        }

        const data = await response.json();
        if (!data || typeof data.version !== "string") {
            logger.warn("Version response did not include a string version");
            return null;
        }

        return data.version;
    } catch (error) {
        logger.error("Error fetching version:", error);
        return null;
    }
}
