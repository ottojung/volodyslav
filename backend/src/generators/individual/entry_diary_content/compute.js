/**
 * Computes the diary content for a specific (event, audio) pair.
 *
 * Combines the event's typed text with the transcribed audio recording text,
 * making both available to downstream consumers such as the diary summarizer.
 *
 * Returns "N/A" when the event is not a diary entry.
 * Otherwise returns an object with both content fields (either may be undefined
 * if the respective source has no meaningful text).
 */

const { getType } = require("../../../event");

/** @typedef {import('../../incremental_graph/database/types').EventTranscriptionEntry} EventTranscriptionEntry */
/** @typedef {import('../../incremental_graph/database/types').EntryDiaryContentEntry} EntryDiaryContentEntry */

/**
 * Returns the text if it is non-empty, otherwise undefined.
 *
 * @param {string | undefined | null} text
 * @returns {string | undefined}
 */
function toDefinedText(text) {
    return text && text.trim() !== "" ? text : undefined;
}

/**
 * Computes the diary content entry for a given event transcription.
 *
 * @param {EventTranscriptionEntry} eventTranscriptionEntry
 * @returns {EntryDiaryContentEntry}
 */
function computeEntryDiaryContent(eventTranscriptionEntry) {
    const { event, transcription } = eventTranscriptionEntry;

    if (getType(event) !== "diary") {
        return { type: "entry_diary_content", value: "N/A" };
    }

    const typedText = toDefinedText(event.input);

    const transcribedAudioRecording = !("message" in transcription)
        ? toDefinedText(transcription.text)
        : undefined;

    return {
        type: "entry_diary_content",
        value: { typed_text: typedText, transcribed_audio_recording: transcribedAudioRecording },
    };
}

module.exports = {
    computeEntryDiaryContent,
};
