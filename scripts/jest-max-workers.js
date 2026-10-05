/**
 * The one statement of what JEST_MAX_WORKERS may be set to.
 *
 * Every way of starting Jest in this monorepo resolves its worker count through
 * this module, whether the caller is a script in scripts/ or a Jest configuration
 * file. The grammar lives here alone; scripts/check-jest-max-workers and the
 * jest.config.js files are callers, not authorities.
 *
 * The grammar is deliberately narrower than Number(). Number() would accept
 * " 4", "+4", "4.0" and "1e2", and Jest would honour all four, but a value whose
 * worker count is a guess is not a worker count. Leading zeros are accepted,
 * because Jest computes 8 from "08" and this gate must not refuse a value the
 * configuration would honour.
 */

const { realpathSync } = require("node:fs");

/** @typedef {{ status: "unset" }} WorkerCountUnset */

/**
 * @typedef {object} WorkerCountAccepted
 * @property {"accepted"} status
 * @property {number} workers
 */

/**
 * @typedef {object} WorkerCountRejected
 * @property {"rejected"} status
 * @property {string} reason - why the value is not a worker count.
 */

/** @typedef {WorkerCountUnset | WorkerCountAccepted | WorkerCountRejected} WorkerCount */

/** The worker count used when JEST_MAX_WORKERS is unset. */
const DEFAULT_WORKERS = 1;

/**
 * @param {string} value
 * @returns {string}
 */
function describe(value) {
    return value === "" ? "the empty value" : `"${value}"`;
}

/**
 * Decide what a caller-provided worker count means.
 *
 * The properties that this function carries are:
 * - an "accepted" result means the value is one or more decimal digits and
 *   `workers` is the whole number they denote, at least one.
 * - a "rejected" result means the value is not such a number and `reason` names
 *   the offending value.
 * - an "unset" result means the caller supplied nothing and the count this
 *   repository asks for applies.
 *
 * The proof of those properties is guaranteed by:
 * - `readWorkerCount(...)`: is the only function in this module that produces a
 *   WorkerCount, and it reaches "accepted" only for a value matching /^[0-9]+$/
 *   whose text contains at least one non-zero digit, which is exactly one or more
 *   decimal digits of at least one; it converts with Number() from that same text
 *   so `workers` is the number the digits denote.
 *
 * @param {string | undefined} value - the raw environment value, or undefined
 *   when the variable is not set at all.
 * @returns {WorkerCount}
 */
function readWorkerCount(value) {
    if (value === undefined) {
        return { status: "unset" };
    }

    const isDecimalDigits = /^[0-9]+$/.test(value);
    const hasAWorker = /[1-9]/.test(value);

    if (isDecimalDigits && hasAWorker) {
        return { status: "accepted", workers: Number(value) };
    }

    const reason = value === "" || !isDecimalDigits
        ? `${describe(value)} is not a whole number written in decimal digits`
        : `${describe(value)} counts no workers`;

    return { status: "rejected", reason };
}

/**
 * The message a rejected value is reported with.
 *
 * @param {WorkerCountRejected} rejection
 * @returns {string}
 */
function rejectionMessage(rejection) {
    return `ERROR: JEST_MAX_WORKERS must be a whole number of 1 or more, but ${rejection.reason}.\n\n`
        + "Unset it to run the suite at one worker, or set it to a positive\n"
        + "count of workers written in decimal digits.\n";
}

/**
 * @param {WorkerCount} workerCount
 * @returns {number}
 */
function workerCountOrDefault(workerCount) {
    if (workerCount.status === "accepted") {
        return workerCount.workers;
    }
    if (workerCount.status === "unset") {
        return DEFAULT_WORKERS;
    }
    throw new RejectedWorkerCountError(workerCount);
}

/**
 * Thrown when a caller-supplied worker count is not a worker count.
 *
 * The properties that this class carries are:
 * - the run was refused, so no Jest process starts with the offending count.
 * - `message` names JEST_MAX_WORKERS and the rejected value.
 *
 * The proof of those properties is guaranteed by:
 * - `workerCountOrDefault(...)`: satisfies the first property because it throws
 *   only for a "rejected" WorkerCount, and every Jest configuration in this
 *   repository reaches its `maxWorkers` through this function, so the refusal
 *   happens before Jest reads any worker count.
 * - `workerCountOrDefault(...)`: satisfies the second property because the
 *   message is built by `rejectionMessage(...)`, which embeds `reason`, and
 *   `reason` embeds the offending value's text.
 */
class RejectedWorkerCountError extends Error {
    /**
     * @param {WorkerCountRejected} rejection
     */
    constructor(rejection) {
        super(rejectionMessage(rejection));
        this.name = "RejectedWorkerCountError";
        this.reason = rejection.reason;
    }
}

/**
 * @param {unknown} object
 * @returns {object is RejectedWorkerCountError}
 */
function isRejectedWorkerCountError(object) {
    return object instanceof RejectedWorkerCountError;
}

/**
 * Resolve the worker count for a Jest configuration file, refusing a value that
 * is not a worker count by throwing rather than by returning a number.
 *
 * @param {NodeJS.ProcessEnv | undefined} environment
 * @returns {number}
 */
function maxWorkersForConfiguration(environment) {
    const rawValue = environment === undefined ? undefined : environment["JEST_MAX_WORKERS"];
    return workerCountOrDefault(readWorkerCount(rawValue));
}

/**
 * Whether a Jest configuration file located in `configurationDirectory` is the
 * root configuration of the current run rather than one project among several.
 *
 * Jest resolves and validates every entry of a `projects` list as an individual
 * project configuration, and it reports `maxWorkers` there as an option that
 * "is not supported in an individual project configuration". The worker count is
 * a global option, so it belongs to whichever configuration supplies the global
 * config, and that is the one Jest was pointed at by starting Jest in this
 * directory. When a workspace configuration is read as a project of the root
 * run, the root configuration has already resolved and refused the same value,
 * so there is nothing left for it to say.
 *
 * Both sides are compared as real paths because Jest compares its working
 * directory the same way, and a symbolic link in the path would otherwise make
 * this answer false for a run started in the intended directory.
 *
 * @param {string} configurationDirectory
 * @returns {boolean}
 */
function isRootConfigurationOfThisRun(configurationDirectory) {
    return realpathSync(process.cwd()) === realpathSync(configurationDirectory);
}

/**
 * Report a rejected worker count on stderr and exit non-zero.
 *
 * @param {WorkerCountRejected} rejection
 * @returns {never}
 */
function refuse(rejection) {
    process.stderr.write(rejectionMessage(rejection));
    process.exit(1);
}

/**
 * @returns {void}
 */
function checkFromCommandLine() {
    const workerCount = readWorkerCount(process.env["JEST_MAX_WORKERS"]);

    if (workerCount.status === "rejected") {
        refuse(workerCount);
    }
}

if (require.main === module) {
    checkFromCommandLine();
}

module.exports = {
    RejectedWorkerCountError,
    isRejectedWorkerCountError,
    isRootConfigurationOfThisRun,
    maxWorkersForConfiguration,
    readWorkerCount,
    workerCountOrDefault,
};