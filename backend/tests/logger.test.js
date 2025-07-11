const fs = require("fs");
const path = require("path");
const { make } = require("../src/logger");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime } = require("./stubs");
const { make: makeTimer } = require("../src/timer");

describe("logger capability", () => {
    it("writes info, warn, error, and debug to file", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubDatetime(capabilities);
        const tmpDir = await capabilities.creator.createTemporaryDirectory(capabilities);
        const logFilePath = path.join(tmpDir, "test.log");
        capabilities.environment.logFile = () => logFilePath;
        capabilities.environment.logLevel = () => "debug";
        const logger = make(() => capabilities);
        await logger.setup();
        logger.logInfo({ foo: 1 }, "info message");
        logger.logWarning({ bar: 2 }, "warn message");
        logger.logError({ baz: 3 }, "error message");
        logger.logDebug({ qux: 4 }, "debug message");
        await capabilities.timer.wait(1000);
        const content = fs.readFileSync(logFilePath, "utf8");
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
            const timer = makeTimer();
            logger.logError({}, "should fallback");
            await timer.wait(50);
            expect(called).toBe(true);
        } finally {
            console.error = origError;
        }
    });

    it("respects log level", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        const tmpDir = await capabilities.creator.createTemporaryDirectory(capabilities);
        const logFilePath = path.join(tmpDir, "test.log");
        capabilities.environment.logFile = () => logFilePath;
        capabilities.environment.logLevel = () => "error";
        const logger = make(() => capabilities);
        await logger.setup();
        logger.logInfo({}, "info should not appear");
        logger.logError({}, "error should appear");
        await capabilities.timer.wait(1000);
        const content = fs.readFileSync(logFilePath, "utf8");
        expect(content).not.toMatch(/info should not appear/);
        expect(content).toMatch(/error should appear/);
    });

    it("printf prints to stderr", () => {
        let called = false;
        const origError = console.log;
        console.log = (...args) => {
            called = args;
        };
        try {
            const logger = make();
            logger.printf("hello");
            expect(called).toEqual(["hello"]);
        } finally {
            console.log = origError;
        }
    });
});
