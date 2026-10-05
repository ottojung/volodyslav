// Jest configuration for backend project
const { isGlobalConfigurationOfThisRun, maxWorkersForConfiguration } = require("../scripts");

/**
 * Resolved on every path this file is read on, before the question of whether
 * this file states the count at all.
 *
 * Jest run with this workspace as its root finds this file and no other, so
 * without the count below JEST_MAX_WORKERS would have no reader here and a start
 * of the backend tests from inside this directory would run at Jest's own default
 * of one worker per core minus one. Resolving the count before deciding whether
 * to state it is what makes every way of naming this file refuse a value that is
 * not a worker count: pointing Jest at this file with the configuration option,
 * or naming this workspace as a project of another run, reads this line too.
 */
const workerCount = maxWorkersForConfiguration(process.env);

module.exports = {
    /**
     * Stated only when this file is the global configuration of the run being
     * read. Read as one project of the repository run, the worker count is a
     * global option that Jest answers "is not supported in an individual project
     * configuration", and the repository jest.config.js has already resolved the
     * same value from the same variable and refused it if it was not a worker
     * count.
     */
    ...(isGlobalConfigurationOfThisRun(__filename) ? { maxWorkers: workerCount } : {}),
};
