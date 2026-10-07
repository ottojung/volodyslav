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
 *
 * The grammar has two ends, and both are refusals. A value that is not a whole
 * number of workers is refused, and a value larger than the host's available
 * parallelism is refused as well, because that count is the oversubscription the
 * variable exists to control: Jest's own default of one worker per core minus
 * one is measured from the machine, and a count above what the machine offers
 * schedules every worker at once and turns wall-clock budgets into timeouts.
 */

const { availableParallelism } = require("node:os");

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
 * @property {number} ceiling - the most workers one process may use on this host.
 */

/** @typedef {WorkerCountUnset | WorkerCountAccepted | WorkerCountRejected} WorkerCount */

/** The worker count used when JEST_MAX_WORKERS is unset. */
const DEFAULT_WORKERS = 1;

/**
 * The most workers a single Jest process may use on this host.
 *
 * The properties that this function carries are:
 * - the returned value is at least one.
 *
 * The proof of those properties is guaranteed by:
 * - `availableParallelism()` from node:os: returns a whole number of parallel
 *   units of execution, which is at least one on every host Node runs on, and
 *   returns undefined only on Node versions without the call, which this
 *   repository's engine requirement excludes.
 */
function workerCeiling() {
    return availableParallelism();
}

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
 * - an "accepted" result means the value is one or more decimal digits, the
 *   `workers` is the whole number they denote, at least one, and at most
 *   `ceiling`.
 * - a "rejected" result means the value is not such a number, `reason` names the
 *   offending value, and `ceiling` is the largest accepted count on this host.
 * - an "unset" result means the caller supplied nothing and the count this
 *   repository asks for applies.
 *
 * The proof of those properties is guaranteed by:
 * - `readWorkerCount(...)`: is the only function in this module that produces a
 *   WorkerCount, and it reaches "accepted" only for a value matching /^[0-9]+$/
 *   whose text contains at least one non-zero digit, which is exactly one or more
 *   decimal digits of at least one; it converts with Number() from that same text
 *   so `workers` is the number the digits denote, and it reaches "accepted" for
 *   that value only when `workers` is at most `ceiling`, which every caller
 *   supplies from `workerCeiling()`.
 *
 * @param {string | undefined} value - the raw environment value, or undefined
 *   when the variable is not set at all.
 * @param {number} ceiling - the most workers one process may use on this host.
 * @returns {WorkerCount}
 */
function readWorkerCount(value, ceiling) {
    if (value === undefined) {
        return { status: "unset" };
    }

    const isDecimalDigits = /^[0-9]+$/.test(value);
    const hasAWorker = /[1-9]/.test(value);

    if (isDecimalDigits && hasAWorker) {
        const workers = Number(value);
        if (workers <= ceiling) {
            return { status: "accepted", workers };
        }
        return {
            status: "rejected",
            reason: `${describe(value)} asks for more workers than this host has available to one process`,
            ceiling,
        };
    }

    const reason = value === "" || !isDecimalDigits
        ? `${describe(value)} is not a whole number written in decimal digits`
        : `${describe(value)} counts no workers`;

    return { status: "rejected", reason, ceiling };
}

/**
 * The message a rejected value is reported with.
 *
 * @param {WorkerCountRejected} rejection
 * @returns {string}
 */
function rejectionMessage(rejection) {
    return `ERROR: JEST_MAX_WORKERS must be a whole number of workers between 1 and the `
        + `${rejection.ceiling} this host has available to one process, but ${rejection.reason}.\n\n`
        + "Unset it to run the suite at one worker, or set it to a positive\n"
        + "count of workers written in decimal digits, no greater than the\n"
        + "parallelism this host reports to one process.\n";
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
 * - `message` names JEST_MAX_WORKERS, the rejected value and the count this host
 *   would have accepted.
 *
 * The proof of those properties is guaranteed by:
 * - `workerCountOrDefault(...)`: satisfies the first property because it throws
 *   only for a "rejected" WorkerCount, and every Jest configuration in this
 *   repository reaches its `maxWorkers` through this function, so the refusal
 *   happens before Jest reads any worker count.
 * - `workerCountOrDefault(...)`: satisfies the second property because the
 *   message is built by `rejectionMessage(...)`, which embeds `reason` and
 *   `ceiling`, and `reason` embeds the offending value's text.
 */
class RejectedWorkerCountError extends Error {
    /**
     * @param {WorkerCountRejected} rejection
     */
    constructor(rejection) {
        super(rejectionMessage(rejection));
        this.name = "RejectedWorkerCountError";
        this.reason = rejection.reason;
        this.ceiling = rejection.ceiling;
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
 * Every Jest configuration calls this on every path it is read on, including
 * the path where it will not state the count, so that a refused value is refused
 * however Jest was started.
 *
 * @param {NodeJS.ProcessEnv | undefined} environment
 * @returns {number}
 */
function maxWorkersForConfiguration(environment) {
    const rawValue = environment === undefined ? undefined : environment["JEST_MAX_WORKERS"];
    return workerCountOrDefault(readWorkerCount(rawValue, workerCeiling()));
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
    const workerCount = readWorkerCount(process.env["JEST_MAX_WORKERS"], workerCeiling());

    if (workerCount.status === "rejected") {
        refuse(workerCount);
    }
}

if (require.main === module) {
    checkFromCommandLine();
}

module.exports = {
    DEFAULT_WORKERS,
    RejectedWorkerCountError,
    isRejectedWorkerCountError,
    maxWorkersForConfiguration,
    readWorkerCount,
    workerCountOrDefault,
    workerCeiling,
};
