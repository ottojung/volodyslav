import { API_BASE_URL } from "../api_base_url.js";
import { logger } from "../DescriptionEntry/logger.js";

/**
 * Calls POST /api/sync to synchronize event log and generators database.
 * @param {boolean} [resetToTheirs] - When true, resets local state to the remote (theirs) version.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function postSync(resetToTheirs) {
    try {
        /** @type {{ reset_to_theirs?: boolean }} */
        const body = {};
        if (resetToTheirs === true) {
            body.reset_to_theirs = true;
        }

        const response = await fetch(`${API_BASE_URL}/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (response.status === 204) {
            return { success: true };
        }

        if (response.ok) {
            return { success: true };
        }

        let errorMessage = `Sync failed with status ${response.status}`;
        try {
            const data = await response.json();
            if (data && data.error) {
                errorMessage = data.error;
            }
        } catch {
            // ignore JSON parse errors
        }

        logger.warn("Sync failed:", errorMessage);
        return { success: false, error: errorMessage };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error during sync:", error);
        return { success: false, error: `Network error: ${message}` };
    }
}
