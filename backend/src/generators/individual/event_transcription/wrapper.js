const { deserialize } = require("../../../event");
const { computeEventTranscription } = require("./compute");

/**
 * @typedef {import('../../incremental_graph/types').NodeDefComputor} NodeDefComputor
 */

/**
 * @typedef {import('./compute').TranscriptionCapabilities} Capabilities
 */

/**
 * @type {(capabilities: Capabilities) => NodeDefComputor}
 */
const makeComputor = (capabilities) => async (inputs, _oldValue, bindings) => {
    const eventEntry = inputs[0];
    if (!eventEntry || eventEntry.type !== "event") {
        throw new Error("Expected event input for event_transcription(e, a) computor");
    }
    const transcriptionEntry = inputs[1];
    if (!transcriptionEntry || transcriptionEntry.type !== "transcription") {
        throw new Error("Expected transcription input for event_transcription(e, a) computor");
    }
    const audioPath = bindings.a;
    if (typeof audioPath !== "string") {
        throw new Error("Expected binding 'a' (audio path) to be a string for event_transcription(e, a) computor, got " + JSON.stringify(audioPath));
    }
    return computeEventTranscription(
        capabilities,
        deserialize(eventEntry.value),
        transcriptionEntry.value,
        audioPath,
    );
};

module.exports = {
    makeComputor,
};
