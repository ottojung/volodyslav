/**
 * Resource cleanup helpers for recorder logic.
 *
 * @module recorder_cleanup_helpers
 */

/**
 * Stop all tracks in a stream.
 * @param {MediaStream | null} stream
 * @returns {null}
 */
export function stopStream(stream) {
    if (stream) {
        stream.getTracks().forEach((track) => track.stop());
    }
    return null;
}

/**
 * Disconnect source node and close audio context.
 * @param {MediaStreamAudioSourceNode | null} sourceNode
 * @param {AudioContext | null} audioContext
 * @returns {{ sourceNode: null, audioContext: null, analyserNode: null }}
 */
export function stopAudioGraph(sourceNode, audioContext) {
    try {
        if (sourceNode) {
            sourceNode.disconnect();
        }
        if (audioContext) {
            void audioContext.close();
        }
    } catch {
        // Ignore errors during cleanup
    }
    return {
        sourceNode: null,
        audioContext: null,
        analyserNode: null,
    };
}
