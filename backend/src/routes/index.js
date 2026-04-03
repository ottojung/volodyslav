const root = require("./root");
const upload = require("./upload");
const ping = require("./ping");
const staticRoute = require("./static");
const transcribe = require("./transcribe");
const transcribeAll = require("./transcribe_all");
const periodic = require("./periodic");
const entries = require("./entries");
const config = require("./config");
const ontology = require("./ontology");
const sync = require("./sync");
const graph = require("./graph");
const version = require("./version");
const assets = require("./assets");
const audioRecordingSession = require("./audio_recording_session");
const diarySummary = require("./diary_summary");

module.exports = {
    root,
    upload,
    ping,
    static: staticRoute,
    transcribe,
    transcribeAll,
    periodic,
    entries,
    config,
    ontology,
    sync,
    graph,
    version,
    assets,
    audioRecordingSession,
    diarySummary,
};
