const migrationFixtureHelpers = require("./migration_fixture_helpers");
const incrementalRemoteStub = require("./stub_incremental_database_remote");

module.exports = {
    forceVersion: migrationFixtureHelpers.forceVersion,
    stubIncrementalDatabaseRemoteBranches: incrementalRemoteStub.stubIncrementalDatabaseRemoteBranches,
};
