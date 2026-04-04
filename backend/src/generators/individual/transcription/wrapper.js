const { computeTranscriptionForAssetPath } = require("./compute");

/**
 * @typedef {import('./compute').TranscriptionCapabilities} TranscriptionCapabilities
 */

/**
 * @param {TranscriptionCapabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(capabilities) {
    return async (_inputs, _oldValue, bindings) => {
        const firstBinding = bindings.a;
        if (typeof firstBinding !== "string") {
            throw new Error("Expected binding 'a' to be a string for transcription(a) computor, got " + JSON.stringify(firstBinding));
        }
        return computeTranscriptionForAssetPath(
            firstBinding,
            capabilities,
        );
    };
}

module.exports = {
    makeComputor,
};
