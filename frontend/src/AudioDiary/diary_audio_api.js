/**
 * API client for the diary-audio entry endpoint.
 *
 * @module diary_audio_api
 */

import { extensionForMime } from "./audio_helpers.js";
import { submitEntry } from "../DescriptionEntry/api.js";

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
    const trimmedNote = note.trim();
    const rawInput = trimmedNote
        ? `diary [audiorecording] ${trimmedNote}`
        : "diary [audiorecording]";
    const audioFile = new File([audioBlob], `diary-audio.${ext}`, { type: mimeType });
    const data = await submitEntry(rawInput, undefined, [audioFile]);
    return { entry: data.entry || null };
}
