const { computeEntryDiaryContent } = require("./compute");

/**
 * @typedef {import('../../incremental_graph/types').NodeDefComputor} NodeDefComputor
 */

/**
 * @type {() => NodeDefComputor}
 */
const makeComputor = () => async (inputs) => {
    const eventTranscriptionEntry = inputs[0];
    if (!eventTranscriptionEntry || eventTranscriptionEntry.type !== "event_transcription") {
        throw new Error("Expected event_transcription input for entry_diary_content(e, a) computor");
    }
    return computeEntryDiaryContent(eventTranscriptionEntry);
};

module.exports = {
    makeComputor,
};
