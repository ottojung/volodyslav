import { API_BASE_URL } from "../api_base_url.js";
import { logger } from "../DescriptionEntry/logger.js";

const SYNC_STATUS_POLL_INTERVAL_MS = 1000;

/**
 * @typedef {{ name: string, message: string, causes: string[] }} SyncErrorDetail
 */

/**
 * @typedef {{ status: "idle" | "running" | "success" | "error", error?: { message: string, details: SyncErrorDetail[] } }} SyncResponse
 */

/**
 * @typedef {{ success: boolean, error?: string, details?: SyncErrorDetail[] }} PostSyncResult
 */

/**
 * @returns {Promise<void>}
 */
function waitForNextSyncPoll() {
    return new Promise((resolve) => {
        setTimeout(resolve, SYNC_STATUS_POLL_INTERVAL_MS);
    });
}

/**
 * @param {Response} response
 * @returns {Promise<SyncResponse | null>}
 */
async function readSyncResponse(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * @param {Response} response
 * @returns {Promise<PostSyncResult>}
 */
async function readSyncErrorResponse(response) {
    const data = await readSyncResponse(response);
    const message = data?.error?.message || data?.error || `Sync failed with status ${response.status}`;
    const details = Array.isArray(data?.error?.details) ? data.error.details : undefined;
    logger.warn("Sync failed:", message, details);
    return { success: false, error: message, details };
}

/**
 * @param {SyncResponse | null} data
 * @returns {PostSyncResult}
 */
function toSyncResult(data) {
    if (data?.status === "success") {
        return { success: true };
    }

    if (data?.status === "error") {
        return {
            success: false,
            error: data.error?.message || "Sync failed",
            details: data.error?.details || [],
        };
    }

    if (data?.status === "idle") {
        return {
            success: false,
            error: "Sync did not start. Please try again.",
        };
    }

    return {
        success: false,
        error: "Sync returned an unexpected response.",
    };
}

/**
 * Calls POST /api/sync to synchronize event log and generators database.
 * @param {boolean} [resetToTheirs] - When true, resets local state to the remote (theirs) version.
 * @returns {Promise<PostSyncResult>}
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

        if (!response.ok && response.status !== 202) {
            return await readSyncErrorResponse(response);
        }

        let data = await readSyncResponse(response);

        while (data?.status === "running") {
            await waitForNextSyncPoll();
            const statusResponse = await fetch(`${API_BASE_URL}/sync`);

            if (!statusResponse.ok && statusResponse.status !== 202) {
                return await readSyncErrorResponse(statusResponse);
            }

            data = await readSyncResponse(statusResponse);
        }

        return toSyncResult(data);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error during sync:", error);
        return { success: false, error: `Network error: ${message}` };
    }
}
