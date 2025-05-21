const path = require("path");
const temporary = require("./temporary");
const rootCapabilities = require("../src/capabilities/root");

/**
 * Recursively wraps functions in an object with jest.fn spies, preserving behavior.
 * @param {*} real - The real capabilities object or function
 * @returns {*} - A mocked version with same shape where functions are replaced by jest spies
 */
function mockCapabilities(real) {
    // Wrap standalone functions with jest.fn to spy on calls
    if (typeof real === "function") {
        return jest.fn((...args) => real(...args));
    }
    if (real && typeof real === "object") {
        // Preserve prototype so instances keep their type
        const mocked = Array.isArray(real)
            ? []
            : Object.create(Object.getPrototypeOf(real));
        for (const key of Object.keys(real)) {
            mocked[key] = mockCapabilities(real[key]);
        }
        return mocked;
    }
    // Return primitives unchanged
    return real;
}

const getMockedRootCapabilities = () =>
    mockCapabilities(rootCapabilities.make());

function stubEnvironment(capabilities) {
    capabilities.environment.logLevel = jest.fn().mockReturnValue("debug");
    capabilities.environment.logFile = jest.fn().mockImplementation(() => {
        const dir = temporary.output();
        return path.join(dir, "log.txt");
    });
    capabilities.environment.workingDirectory = jest
        .fn()
        .mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "results");
        });
    capabilities.environment.eventLogRepository = jest
        .fn()
        .mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "eventlog");
        });
    capabilities.environment.eventLogAssetsDirectory = jest
        .fn()
        .mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "assets");
        });
    capabilities.environment.diaryAudiosDirectory = jest
        .fn()
        .mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "diary");
        });
    capabilities.environment.openaiAPIKey = jest
        .fn()
        .mockReturnValue("mocked-openai-key");
    capabilities.environment.myServerPort = jest.fn().mockReturnValue(1234);
}

function stubLogger(capabilities) {
    capabilities.logger.setup = jest.fn();
    capabilities.logger.enableHttpCallsLogging = jest.fn();
    capabilities.logger.logError = jest.fn();
    capabilities.logger.logWarning = jest.fn();
    capabilities.logger.logInfo = jest.fn();
    capabilities.logger.logDebug = jest.fn();
}

function stubNotifier(capabilities) {
    capabilities.notifier.ensureNotificationsAvailable = jest.fn();
    capabilities.notifier.notifyAboutError = jest.fn();
    capabilities.notifier.notifyAboutWarning = jest.fn();
}

function stubScheduler(capabilities) {
    capabilities.scheduler.setup = jest.fn();
}

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

module.exports = { getMockedRootCapabilities, stubEnvironment, stubLogger, stubNotifier, stubScheduler };
