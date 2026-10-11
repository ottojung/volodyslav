/**
 * The public surface of the scripts folder.
 *
 * Files in this folder are imported through this index rather than by path, so
 * that a script's internals can move without a caller noticing. Only what a
 * caller outside the folder needs is exported here.
 */

"use strict";

module.exports = {
    ...require("./jest-configuration-scope"),
    ...require("./jest-max-workers"),
};
