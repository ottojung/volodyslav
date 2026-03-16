const { computeEventTranscription, isAudioNotAssociatedWithEventError } = require("./compute");
const { makeComputor } = require("./wrapper");

module.exports = {
    computeEventTranscription,
    isAudioNotAssociatedWithEventError,
    makeComputor,
};
