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
 * The returned string carries the property that:
 * - It is the content of the log file read at a moment when the transport had
 *   already delivered `expected` into that file.
 *
 * The proof of that property is guaranteed by:
 * - The only function that introduces this value is `readLogFileAfter`, which
 *   satisfies the property because it returns only from inside the branch where
 *   the content it just read contains `expected`, and returns the deadline error
 *   otherwise, so a returned string never precedes the delivery of `expected`.
 */

/**
 * How long a log record is given to reach the file before the wait gives up.
 *
 * A deadline is not a substitute for synchronisation, it is the failure mode of
 * it: the wait ends when the content appears, and the deadline only decides how
 * long a genuine failure is allowed to look like a slow one.
 */
const LOG_WRITE_DEADLINE = fromMilliseconds(2000);

/**
 * How often the log file is inspected while waiting for the content.
 */
const LOG_WRITE_POLL_INTERVAL = fromMilliseconds(10);

/**
 * Reads the log file once the expected record has landed in it.
 *
 * The logger writes through a pino transport that hands every record to a worker
 * thread. With more than one target the worker's destination is a split stream
 * that exposes no completion signal, and the transport's own `flush` acknowledges
 * as soon as that stream accepts the data - before the file target has written it.
 * There is therefore no event to await, and a fixed sleep synchronises with
 * nothing but the clock. Waiting for the content to appear synchronises with the
 * write itself, and fails with a description of what never arrived.
 *
 * @param {Capabilities} capabilities - The capabilities whose reader reads the file.
 * @param {string} logFilePath - The path of the log file to read.
 * @param {string} expected - The text whose arrival is being awaited.
 * @returns {Promise<string>} The log file content containing `expected`.
 */
async function readLogFileAfter(capabilities, logFilePath, expected) {
    let remaining = LOG_WRITE_DEADLINE;
    for (;;) {
        const content = await capabilities.reader.readFileAsText(logFilePath);
        if (content.includes(expected)) {
            return content;
        }

        if (remaining.toMillis() <= 0) {
            throw new Error(
                `Timed out after ${LOG_WRITE_DEADLINE.toMillis()} ms waiting for "${expected}" to reach ${logFilePath}. The file holds ${content.length} bytes.`
            );
        }

        await capabilities.sleeper.sleep(
            "logger-test-wait-for-log-record",
            LOG_WRITE_POLL_INTERVAL
        );
        remaining = remaining.minus(LOG_WRITE_POLL_INTERVAL);
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
            "debug message"
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
            "error should appear"
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
            readLogFileAfter(capabilities, logFilePath, "a record that is never logged")
        ).rejects.toThrow(
            /Timed out after 2000 ms waiting for "a record that is never logged"/
        );
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