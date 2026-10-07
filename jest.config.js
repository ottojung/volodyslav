/**
 * Jest Configuration
 * Runs the backend and frontend projects.
 *
 * Jest's circus runner takes the per-test timeout budget from `globalConfig`,
 * which in a `projects` configuration is the root config. Root-level options are
 * not merged down into the projects named here, so the root `testTimeout` is the
 * only placement that changes the effective budget. `jest_global_setup.js`
 * asserts that the root value and every project value all match the request.
 *
 * `JEST_TEST_TIMEOUT` is this repository's own channel for the budget; Jest
 * itself knows nothing about it, which is why the value is resolved here and
 * written into the configs. A `--testTimeout=N` flag on the command line
 * overrides this declaration, as it overrides every Jest config option.
 */
const { PROJECT_CONFIG_PATHS } = require("./jest_projects");
const { resolveTestTimeout } = require("./jest_test_timeout");
const { maxWorkersForConfiguration } = require("./scripts");

module.exports = {
  projects: PROJECT_CONFIG_PATHS,
  testTimeout: resolveTestTimeout(process.env),
  globalSetup: '<rootDir>/jest_global_setup.js',
  /**
   * Worker count for the whole suite.
   *
   * Jest's default is one worker per core minus one, measured from the machine the
   * suite runs on. On a shared host that count exceeds the cores actually available
   * to this process, every worker is descheduled, and tests with real wall-clock work
   * in them - LevelDB opens, HTTP requests - cross the per-test budget
   * and fail as timeouts rather than as assertions. Measured on a 32-core host with
   * an unrelated load of roughly 10 already present: at the default 31 workers the
   * full suite failed 3 runs out of 3 with 18 to 31 failing suites and drove the
   * host load average to 56 and above, while at one worker all 281 suites and 3600
   * tests passed 3 runs out of 3.
   *
   * One worker removes that oversubscription from the suites whose time is spent
   * waiting on I/O. It does not make the per-test budget real for suites that
   * block the event loop: Jest's watchdog cannot fire while the loop is blocked,
   * so a test can run far past its budget and still report green. Measured at one
   * worker on a 32-core host, `backend/tests/journal_interleaving.test.js` contains
   * no timers and has tests of 9.120 s and 7.418 s that pass against a nominal
   * 5000 ms budget. One worker also does not make the suite deterministic on a
   * host shared with other work: a one-worker full-suite run has been measured
   * green once in four, with every failure a 5000 ms timeout in a different
   * suite. A caller that has the machine to itself can raise the count
   * deliberately by setting JEST_MAX_WORKERS to a whole number of workers no
   * larger than what this host reports available to one process; a larger count
   * is refused, because that is the oversubscription this count exists to
   * prevent.
   *
   * A value that is not a worker count is refused here, by throwing out of the
   * configuration, so that `npx jest` and `bun jest` refuse it too rather than
   * reaching a run at Jest's own default. The grammar is stated once, in
   * scripts/jest-max-workers.
   *
   * What the grammar cannot reach is Jest's own command line, which outranks
   * every configuration value. Jest exposes no hook that observes or refuses its
   * command-line options, so a worker count written there - in a well-formed
   * value or in none at all - leaves the set of runs this repository validates,
   * and the count this file resolves is then not the count the suite runs at.
   * backend/tests/worker_count_gate.test.js pins that no package script, workflow,
   * shell script, Dockerfile, Makefile target or document in this repository
   * names a worker count, a configuration or a project list on Jest's command
   * line, which keeps that channel unused rather than merely described.
   */
  maxWorkers: maxWorkersForConfiguration(process.env),
};
