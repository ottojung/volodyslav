//
// Main entry point for gitstore functionality.
// This module exports the transaction and checkpoint functions, as well as
// the workingRepository utilities.
//

const { transaction } = require("./transaction");
const { checkpoint } = require("./checkpoint");
const workingRepository = require("./working_repository");
const mergeHostBranches = require("./merge_host_branches");

module.exports = {
    transaction,
    checkpoint,
    workingRepository,
    mergeHostBranches,
};
