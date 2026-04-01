/**
 * Entry description module.
 * Provides the description extraction computor for individual diary entries.
 */

const { computeEntryDescription } = require("./compute");
const { computor } = require("./wrapper");

module.exports = {
    computeEntryDescription,
    computor,
};
