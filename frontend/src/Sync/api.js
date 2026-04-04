import { API_BASE_URL } from "../api_base_url.js";
import { logger } from "../DescriptionEntry/logger.js";

const SYNC_STATUS_POLL_INTERVAL_MS = 1000;

/**
 * @typedef {{ name: string, message: string, causes: string[] }} SyncErrorDetail
 */

/**
 * @typedef {{ name: string, status: "success" | "error" }} SyncStepResult
 */

/**
 * @typedef {{ status: "idle" | "running" | "success" | "error", steps?: SyncStepResult[], error?: { message: string, details: SyncErrorDetail[] }, reset_to_hostname?: string }} SyncResponse
 */

/**
 * @typedef {{ success: boolean, error?: string, details?: SyncErrorDetail[], steps?: SyncStepResult[], resetToHostname?: string }} PostSyncResult
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
    const error = data?.error;
    const message = typeof error === "string"
        ? error
        : error?.message || `Sync failed with status ${response.status}`;
    const details = Array.isArray(error?.details) ? error.details : undefined;
    logger.warn("Sync failed:", message, details);
    return { success: false, error: message, details };
}

/**
 * @param {SyncResponse | null} data
 * @returns {PostSyncResult}
 */
function toSyncResult(data) {
    if (data?.status === "success") {
        /** @type {PostSyncResult} */
        const success = { success: true, steps: data.steps };
        const resetToHostname = data.reset_to_hostname;
        if (typeof resetToHostname === "string" && resetToHostname.trim() !== "") {
            return { ...success, resetToHostname };
        }
        return success;
    }

    if (data?.status === "error") {
        return {
            success: false,
            error: data.error?.message || "Sync failed",
            details: data.error?.details || [],
            steps: data.steps,
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
 * Calls POST /api/sync to synchronize persisted application state.
 * @param {string} [resetToHostname] - Optional hostname branch target for reset mode.
 * @param {(steps: SyncStepResult[]) => void} [onProgress] - Called with current step results whenever the running state is polled.
 * @returns {Promise<PostSyncResult>}
 */
export async function postSync(resetToHostname, onProgress) {
    try {
        /** @type {{ reset_to_hostname?: string }} */
        const body = {};
        if (typeof resetToHostname === "string" && resetToHostname.trim() !== "") {
            body.reset_to_hostname = resetToHostname.trim();
        }

        const response = await fetch(`${API_BASE_URL}/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (response.status !== 200 && response.status !== 202 && response.status !== 500) {
            return await readSyncErrorResponse(response);
        }

        let data = await readSyncResponse(response);

        if (data?.status === "running" && data.steps) {
            onProgress?.(data.steps);
        }

        while (data?.status === "running") {
            await waitForNextSyncPoll();
            const statusResponse = await fetch(`${API_BASE_URL}/sync`);

            if (statusResponse.status !== 200 && statusResponse.status !== 202 && statusResponse.status !== 500) {
                return await readSyncErrorResponse(statusResponse);
            }

            data = await readSyncResponse(statusResponse);

            if (data?.status === "running" && data.steps) {
                onProgress?.(data.steps);
            }
        }

        return toSyncResult(data);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error during sync:", error);
        return { success: false, error: `Network error: ${message}` };
    }
}

/**
 * Calls GET /api/sync/hostnames to obtain selectable reset hostnames.
 * @returns {Promise<string[]>}
 */
export async function fetchSyncHostnames() {
    try {
        const response = await fetch(`${API_BASE_URL}/sync/hostnames`);
        if (!response.ok) {
            logger.warn("Failed to fetch sync hostnames:", response.status);
            return [];
        }

        const data = await response.json();
        if (!data || !Array.isArray(data.hostnames)) {
            logger.warn("Sync hostnames response did not include an array");
            return [];
        }

        /** @type {string[]} */
        const hostnames = [];
        for (const hostname of data.hostnames) {
            if (typeof hostname === "string") {
                hostnames.push(hostname);
            }
        }
        return hostnames;
    } catch (error) {
        logger.error("Error fetching sync hostnames:", error);
        return [];
    }
}

/**
 * Calls GET /api/sync to retrieve the current sync state.
 * @returns {Promise<SyncResponse>}
 */
export async function fetchSyncState() {
    try {
        const response = await fetch(`${API_BASE_URL}/sync`);
        if (response.status !== 200 && response.status !== 202 && response.status !== 500) {
            logger.warn("Unexpected sync state response status:", response.status);
            return { status: "idle" };
        }
        const data = await readSyncResponse(response);
        return data ?? { status: "idle" };
    } catch (error) {
        logger.error("Error fetching sync state:", error);
        return { status: "idle" };
    }
}
