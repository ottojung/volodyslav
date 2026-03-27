/**
 * API client for the diary-audio entry endpoint.
 *
 * @module diary_audio_api
 */

import { API_BASE_URL } from "../api_base_url.js";
import { extensionForMime } from "./audio_helpers.js";

/**
 * Submit a diary audio recording as a new entry.
 * The backend constructs the canonical rawInput from the note.
 *
 * @param {Blob} audioBlob - The final combined audio blob.
 * @param {string} mimeType - MIME type of the audio.
 * @param {string} [note] - Optional user note.
 * @returns {Promise<{ entry: { id: string } | null }>}
 */
export async function submitDiaryAudio(audioBlob, mimeType, note = "") {
    const ext = extensionForMime(mimeType);
    const formData = new FormData();
    formData.append("audio", audioBlob, `diary-audio.${ext}`);
    if (note.trim()) {
        formData.append("note", note.trim());
    }

    const response = await fetch(`${API_BASE_URL}/entries/diary-audio`, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Diary audio submission failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Diary audio submission failed");
    }

    return { entry: data.entry || null };
}
