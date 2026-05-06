//
// Main entry point for gitstore functionality.
// This module exports the transaction and checkpoint functions, as well as
// the workingRepository utilities.
//

const { transaction } = require("./transaction");
const { checkpoint, checkpointSession } = require("./checkpoint");
const workingRepository = require("./working_repository");
const mergeHostBranches = require("./merge_host_branches");
const { configureRemoteForAllBranches } = require("./branch_setup");
const defaultBranch = require("./default_branch");

module.exports = {
    transaction,
    checkpoint,
    checkpointSession,
    workingRepository,
    mergeHostBranches,
    configureRemoteForAllBranches,
    defaultBranch,
};
