import { API_BASE_URL } from "../api_base_url.js";
import { logger } from "../DescriptionEntry/logger.js";

const DIARY_SUMMARY_POLL_INTERVAL_MS = 1000;

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
 * @typedef {{ path: string, status: "pending" | "success" | "error" }} DiarySummaryRunEntry
 */

/**
 * @typedef {{ status: "idle" | "running" | "success" | "error", entries?: DiarySummaryRunEntry[], summary?: DiarySummaryData, error?: string }} DiarySummaryRunResponse
 */

/**
 * @typedef {{ success: boolean, summary?: DiarySummaryData, error?: string, entries?: DiarySummaryRunEntry[] }} RunDiarySummaryResult
 */

/**
 * @returns {Promise<void>}
 */
function waitForNextDiarySummaryPoll() {
    return new Promise((resolve) => {
        setTimeout(resolve, DIARY_SUMMARY_POLL_INTERVAL_MS);
    });
}

/**
 * @param {Response} response
 * @returns {Promise<DiarySummaryRunResponse | null>}
 */
async function readDiarySummaryRunResponse(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

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
 * Triggers the diary summary pipeline and polls until it completes.
 * @param {(entries: DiarySummaryRunEntry[]) => void} [onProgress] - Called with current entries whenever the running state is polled.
 * @param {AbortSignal} [signal] - If provided, polling and progress callbacks stop when the signal is aborted.
 * @returns {Promise<RunDiarySummaryResult>}
 */
export async function runDiarySummary(onProgress, signal) {
    try {
        const response = await fetch(`${API_BASE_URL}/diary-summary/run`, {
            method: "POST",
            signal,
        });

        if (response.status !== 200 && response.status !== 202 && response.status !== 500) {
            logger.warn("Failed to run diary summary:", response.status);
            return { success: false, error: `Request failed with status ${response.status}` };
        }

        let data = await readDiarySummaryRunResponse(response);

        if (data?.status === "running" && data.entries && !signal?.aborted) {
            onProgress?.(data.entries);
        }

        while (data?.status === "running" && !signal?.aborted) {
            await waitForNextDiarySummaryPoll();
            if (signal?.aborted) {
                break;
            }
            const statusResponse = await fetch(`${API_BASE_URL}/diary-summary/run`);

            if (statusResponse.status !== 200 && statusResponse.status !== 202 && statusResponse.status !== 500) {
                logger.warn("Failed to poll diary summary run status:", statusResponse.status);
                return { success: false, error: `Polling failed with status ${statusResponse.status}` };
            }

            data = await readDiarySummaryRunResponse(statusResponse);

            if (data?.status === "running" && data.entries && !signal?.aborted) {
                onProgress?.(data.entries);
            }
        }

        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        if (data?.status === "success" && data.summary) {
            if (data.entries) {
                onProgress?.(data.entries);
            }
            return { success: true, summary: data.summary, entries: data.entries };
        }

        if (data?.status === "error") {
            logger.warn("Diary summary pipeline failed:", data.error);
            if (data.entries) {
                onProgress?.(data.entries);
            }
            return { success: false, error: data.error, entries: data.entries };
        }

        logger.warn("Diary summary run returned unexpected state:", data?.status);
        return { success: false, error: "Unexpected response from server" };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            return { success: false, error: "Aborted" };
        }
        logger.error("Error running diary summary:", error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
