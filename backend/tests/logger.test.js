const path = require("path");
const { make } = require("../src/logger");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime } = require("./stubs");
const { make: makeSleeper } = require("../src/sleeper");
const { fromMilliseconds } = require("../src/datetime/duration");

/**
 * @typedef {object} Capabilities
 * @property {import('../src/filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../src/sleeper').Sleeper} sleeper - A sleeper instance.
 */

/**
 * How long a log record is given to reach the file before the wait gives up.
 *
 * A deadline is not a substitute for synchronisation, it is the failure mode of
 * it: the wait ends when the content appears, and the deadline only decides how
 * long a genuine failure is allowed to look like a slow one.
 *
 * The deadline is elapsed time on the host's monotonic clock, not a count of
 * polls, so a host that stretches `setTimeout` shortens the wait instead of
 * quietly multiplying it.
 */
const LOG_WRITE_DEADLINE = fromMilliseconds(2000);

/**
 * How often the log file is inspected while waiting for the content.
 */
const LOG_WRITE_POLL_INTERVAL = fromMilliseconds(10);

/**
 * The budget every logger test waits under unless it is the deadline itself
 * that is under test.
 */
const LOG_WRITE_BUDGET = {
    deadline: LOG_WRITE_DEADLINE,
    pollInterval: LOG_WRITE_POLL_INTERVAL,
};

/**
 * Reads the host's monotonic clock, in milliseconds.
 *
 * `capabilities.datetime` cannot measure this wait. `stubDatetime` pins
 * `datetime.now()` to a constant, and the tests that need a frozen clock are the
 * same tests that need a wait that expires: a deadline measured against a clock
 * that does not move never expires. The monotonic clock is read from the host
 * instead, and it is monotonic, so a wall-clock adjustment during the wait cannot
 * stretch the deadline.
 *
 * @returns {number} Milliseconds on the host's monotonic clock.
 */
function monotonicMillis() {
    return Number(process.hrtime.bigint() / BigInt(1000000));
}

/**
 * Decides whether the file content already holds the awaited record.
 *
 * A record is one complete JSON line whose `msg` is the awaited message. The
 * condition is record identity rather than a substring of the whole file, so a
 * record that merely starts with the awaited text, and a record left over from an
 * earlier run, cannot satisfy the wait. The last element is dropped because a
 * file being appended to ends either with the newline that closes the last
 * complete record or with a record the logger has not finished writing.
 *
 * @param {string} content - The log file content read so far.
 * @param {string} expected - The message of the awaited record.
 * @returns {boolean} Whether a complete record carries `expected` as its message.
 */
function holdsRecordWithMessage(content, expected) {
    const lines = content.split("\n");
    lines.pop();
    return lines.some((line) => {
        if (line.length === 0) {
            return false;
        }
        try {
            const record = JSON.parse(line);
            return record.msg === expected;
        } catch (error) {
            return false;
        }
    });
}

/**
 * @typedef {object} WaitBudget
 * @property {import('../src/datetime').Duration} deadline - Elapsed time the wait may take before it gives up.
 * @property {import('../src/datetime').Duration} pollInterval - Time between two inspections of the file.
 */

/**
 * Reads the log file once the awaited record has landed in it.
 *
 * The logger writes through a pino transport that hands every record to a worker
 * thread. With more than one target the worker's destination is a split stream
 * that exposes no completion signal, and the transport's own `flush` acknowledges
 * as soon as that stream accepts the data - before the file target has written it.
 * There is therefore no event to await, and a fixed sleep synchronises with
 * nothing but the clock. Waiting for the record to appear synchronises with the
 * write itself, and fails with a description of what never arrived.
 *
 * @param {Capabilities} capabilities - The capabilities whose reader reads the file and whose sleeper waits.
 * @param {string} logFilePath - The path of the log file to read.
 * @param {string} expected - The message of the awaited record.
 * @param {WaitBudget} budget - How long to wait and how often to look.
 * @returns {Promise<string>} The log file content read once the awaited record is in it.
 *
 * The returned string carries the properties that:
 * - It is the content of the log file read at a moment when a complete record
 *   whose message is `expected` had already been written into that file.
 * - That file is one this test created, so no record from an earlier run can be
 *   in it.
 *
 * The proof is guaranteed by:
 * - `readLogFileAfter` returns only from the branch where
 *   `holdsRecordWithMessage` found a complete line whose `msg` equals `expected`
 *   in the content it had just read, so a returned string never precedes the
 *   write of the awaited record.
 * - Every caller allocates the path with `createTemporaryDirectory`, which is
 *   `fs.mkdtemp` and therefore unique per call, and passes a file path inside
 *   that directory. The introduction sites are the `reads info, warn, error, and
 *   debug to file`, `respects log level` and
 *   `waits for the record itself rather than for text that contains it` tests.
 *   `createFileTarget` in `backend/src/logger/setup.js` reuses an existing file
 *   rather than truncating it, so this property rests on the callers above and
 *   not on the module alone.
 */
async function readLogFileAfter(capabilities, logFilePath, expected, budget) {
    const startedAt = monotonicMillis();
    const deadlineMillis = budget.deadline.toMillis();
    for (;;) {
        const content = await capabilities.reader.readFileAsText(logFilePath);
        if (holdsRecordWithMessage(content, expected)) {
            return content;
        }

        const elapsedMillis = monotonicMillis() - startedAt;
        if (elapsedMillis >= deadlineMillis) {
            const remainingMillis = deadlineMillis - elapsedMillis;
            throw new Error(
                `Timed out after ${elapsedMillis} ms of a ${deadlineMillis} ms budget, ${remainingMillis} ms remaining, waiting for the record with message "${expected}" to reach ${logFilePath}. The file holds ${content.length} bytes.`
            );
        }

        await capabilities.sleeper.sleep(
            "logger-test-wait-for-log-record",
            budget.pollInterval
        );
    }
}

describe("logger capability", () => {
    it("writes info, warn, error, and debug to file", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubDatetime(capabilities);
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const logFilePath = path.join(tmpDir, "test.log");
        capabilities.environment.logFile = () => logFilePath;
        capabilities.environment.logLevel = () => "debug";
        const logger = make(() => capabilities);
        await logger.setup();
        logger.logInfo({ foo: 1 }, "info message");
        logger.logWarning({ bar: 2 }, "warn message");
        logger.logError({ baz: 3 }, "error message");
        logger.logDebug({ qux: 4 }, "debug message");
        const content = await readLogFileAfter(
            capabilities,
            logFilePath,
            "debug message",
            LOG_WRITE_BUDGET
        );
        expect(content).toMatch(/info message/);
        expect(content).toMatch(/warn message/);
        expect(content).toMatch(/error message/);
        expect(content).toMatch(/debug message/);
    });

    it("falls back to console if not initialized", async () => {
        let called = false;
        const origError = console.error;
        console.error = () => {
            called = true;
        };
        try {
            const logger = make();
            const sleeper = makeSleeper();
            logger.logError({}, "should fallback");
            await sleeper.sleep("test1", fromMilliseconds(50));
            expect(called).toBe(true);
        } finally {
            console.error = origError;
        }
    });

    it("respects log level", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const logFilePath = path.join(tmpDir, "test.log");
        capabilities.environment.logFile = () => logFilePath;
        capabilities.environment.logLevel = () => "error";
        const logger = make(() => capabilities);
        await logger.setup();
        logger.logInfo({}, "info should not appear");
        logger.logError({}, "error should appear");
        const content = await readLogFileAfter(
            capabilities,
            logFilePath,
            "error should appear",
            LOG_WRITE_BUDGET
        );
        expect(content).not.toMatch(/info should not appear/);
        expect(content).toMatch(/error should appear/);
    });

    it("fails the wait loudly when the record never reaches the file", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubDatetime(capabilities);
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const logFilePath = path.join(tmpDir, "test.log");
        capabilities.environment.logFile = () => logFilePath;
        capabilities.environment.logLevel = () => "debug";
        const logger = make(() => capabilities);
        await logger.setup();
        logger.logInfo({ foo: 1 }, "info message");
        await expect(
            readLogFileAfter(
                capabilities,
                logFilePath,
                "a record that is never logged",
                LOG_WRITE_BUDGET
            )
        ).rejects.toThrow(
            /Timed out after \d+ ms of a 2000 ms budget, -?\d+ ms remaining, waiting for the record with message "a record that is never logged"/
        );
    });

    it("reports the milliseconds it waited rather than the budget it was given", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubDatetime(capabilities);
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const logFilePath = path.join(tmpDir, "test.log");
        capabilities.environment.logFile = () => logFilePath;
        capabilities.environment.logLevel = () => "debug";
        const logger = make(() => capabilities);
        await logger.setup();

        // The poll interval is longer than the whole deadline, so the wait ends on
        // the poll that already overshot the budget. A wait counted in polls would
        // report the 50 ms it was given; only a wait measured on the clock can
        // report the 500 ms it spent asleep.
        let message = null;
        const startedAt = monotonicMillis();
        try {
            await readLogFileAfter(capabilities, logFilePath, "never logged", {
                deadline: fromMilliseconds(50),
                pollInterval: fromMilliseconds(500),
            });
        } catch (error) {
            message = error.message;
        }
        const waitedMillis = monotonicMillis() - startedAt;

        const reported = message.match(
            /^Timed out after (\d+) ms of a 50 ms budget, (-?\d+) ms remaining,/
        );
        expect(reported).not.toBeNull();
        const [, reportedMillis, remainingMillis] = reported;
        expect(Number(reportedMillis)).toBeGreaterThanOrEqual(450);
        expect(Number(reportedMillis)).toBeLessThanOrEqual(waitedMillis);
        expect(Number(remainingMillis)).toBeLessThanOrEqual(0);
    });

    it("waits for the record itself rather than for text that contains it", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubDatetime(capabilities);
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const logFilePath = path.join(tmpDir, "test.log");
        capabilities.environment.logFile = () => logFilePath;
        capabilities.environment.logLevel = () => "debug";
        const logger = make(() => capabilities);
        await logger.setup();
        logger.logInfo({}, "sentinel record: retry");

        // A file holding only a record that starts with the awaited text has not
        // delivered the awaited record.
        await expect(
            readLogFileAfter(capabilities, logFilePath, "sentinel record", {
                deadline: fromMilliseconds(300),
                pollInterval: fromMilliseconds(10),
            })
        ).rejects.toThrow(/waiting for the record with message "sentinel record"/);

        logger.logInfo({}, "sentinel record");
        const content = await readLogFileAfter(
            capabilities,
            logFilePath,
            "sentinel record",
            LOG_WRITE_BUDGET
        );
        expect(content).toMatch(/"msg":"sentinel record"/);
    });

    it("printf prints to stderr", () => {
        let called = false;
        const origLog = console.log;
        console.log = (...args) => {
            called = args;
        };
        try {
            const logger = make();
            logger.printf("hello");
            expect(called).toEqual(["hello"]);
        } finally {
            console.log = origLog;
        }
    });
});
