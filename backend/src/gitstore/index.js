//
// Main entry point for gitstore functionality.
// This module exports the transaction function by delegating to the retry module.
//

const { transaction } = require("./transaction");
const workingRepository = require("./working_repository");

module.exports = {
    transaction,
    workingRepository,
};
