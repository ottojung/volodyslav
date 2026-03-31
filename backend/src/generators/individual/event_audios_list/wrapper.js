const { computeEventAudiosList } = require("./compute");

/**
 * @typedef {import('./compute').EventAudiosListCapabilities} EventAudiosListCapabilities
 */

/**
 * @param {EventAudiosListCapabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(capabilities) {
    return async (inputs, _oldValue, _bindings) => {
        const eventEntry = inputs[0];
        if (!eventEntry || eventEntry.type !== "event") {
            throw new Error("Expected event input for event_audios_list(e) computor");
        }
        return computeEventAudiosList(capabilities, eventEntry.value);
    };
}

module.exports = {
    makeComputor,
};
