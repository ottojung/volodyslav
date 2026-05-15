const backend = require("./src");
const backendTests = require("./tests");

module.exports = {
    makeInterface: backend.makeInterface,
    DATABASE_SUBPATH: backend.DATABASE_SUBPATH,
    makeRootCapabilities: backend.makeRootCapabilities,
    forceVersion: backendTests.forceVersion,
    stubIncrementalDatabaseRemoteBranches: backendTests.stubIncrementalDatabaseRemoteBranches,
};
