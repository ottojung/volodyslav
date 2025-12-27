const root = require("./root");
const upload = require("./upload");
const ping = require("./ping");
const staticRoute = require("./static");
const transcribe = require("./transcribe");
const transcribeAll = require("./transcribe_all");
const periodic = require("./periodic");
const entries = require("./entries");
const config = require("./config");

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
};
