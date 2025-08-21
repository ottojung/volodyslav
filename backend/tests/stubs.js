const path = require("path");
const fs = require("fs");
const os = require("os");
const { stubEventLogRepository } = require("./stub_event_log_repository");

/**
 * Stubs the environment capabilities for testing.
 * Makes up temporary directories for input and output.
 */
function stubEnvironment(capabilities) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jest-"));
    const input = path.join(tmpDir, "input");
    const output = path.join(tmpDir, "output");

    capabilities.environment = {};
    capabilities.environment.logLevel = jest.fn().mockReturnValue("debug");
    capabilities.environment.logFile = jest.fn().mockImplementation(() => {
        const dir = output;
        return path.join(dir, "log.txt");
    });
    capabilities.environment.workingDirectory = jest
        .fn()
        .mockImplementation(() => {
            const dir = output;
            return path.join(dir, "results");
        });
    capabilities.environment.eventLogRepository = jest
        .fn()
        .mockImplementation(() => {
            const dir = output;
            return path.join(dir, "eventlog");
        });
    capabilities.environment.eventLogAssetsDirectory = jest
        .fn()
        .mockImplementation(() => {
            const dir = output;
            return path.join(dir, "assets");
        });
    capabilities.environment.diaryAudiosDirectory = jest
        .fn()
        .mockImplementation(() => {
            const dir = input;
            return path.join(dir, "diary");
        });
    capabilities.environment.openaiAPIKey = jest
        .fn()
        .mockReturnValue("mocked-openai-key");
    capabilities.environment.myServerPort = jest.fn().mockReturnValue(1234);
    capabilities.environment.ensureEnvironmentIsInitialized = jest.fn();
}

/**
 * Stubs the logger capabilities for testing.
 * Silences all logging functions.
 */
function stubLogger(capabilities) {
    capabilities.logger = {};
    capabilities.logger.setup = jest.fn();
    capabilities.logger.enableHttpCallsLogging = jest.fn();
    capabilities.logger.logError = jest.fn();
    capabilities.logger.logWarning = jest.fn();
    capabilities.logger.logInfo = jest.fn();
    capabilities.logger.logDebug = jest.fn();
    capabilities.logger.printf = jest.fn();
}

/**
 * Stubs the AI transcription capabilities for testing.
 */
function stubAiTranscriber(capabilities) {
    capabilities.aiTranscription.transcribeStream = jest
        .fn()
        .mockResolvedValue("mocked transcription result");
    capabilities.aiTranscription.getTranscriberInfo = jest.fn().mockReturnValue({
        name: "mocked-transcriber",
        creator: "Mocked Creator",
    });
}

/**
 * Stubs the notifier capabilities for testing.
 * Silences all notification functions.
 */
function stubNotifier(capabilities) {
    capabilities.notifier.ensureNotificationsAvailable = jest.fn();
    capabilities.notifier.notifyAboutError = jest.fn();
    capabilities.notifier.notifyAboutWarning = jest.fn();
}

function stubSleeper(capabilities) {
    capabilities.sleeper.sleep = jest.fn().mockImplementation((_ms) => {
        return Promise.resolve(); // Immediately resolve when stubbed
    });
}

function stubDatetime(capabilities) {
    const { makeMockedDatetime } = require("../src/datetime_mock");
    capabilities.datetime = makeMockedDatetime();
}

/**
 * Provides access to datetime manipulation functions when datetime is stubbed.
 * @param {any} capabilities - The capabilities object with stubbed datetime
 * @returns {{setTime: (ms: number) => void, advanceTime: (ms: number) => void, getCurrentTime: () => number}}
 */
function getDatetimeControl(capabilities) {
    const { isMockedDatetime } = require("../src/datetime_mock");
    if (!isMockedDatetime(capabilities.datetime)) {
        throw new Error("Datetime must be stubbed with stubDatetime() to use datetime control");
    }
    return {
        setTime: (ms) => capabilities.datetime.setTime(ms),
        advanceTime: (ms) => capabilities.datetime.advanceTime(ms),
        getCurrentTime: () => capabilities.datetime.getCurrentTime(),
    };
}

function stubApp() {
    return {
        use: jest.fn(),
    };
}

function stubGit(capabilities, call) {
    capabilities.git = {
        ...capabilities.git,
        call: jest.fn().mockImplementation(call),
    };
}

function stubTranscription(capabilities, transcribeFileImpl) {
    capabilities.aiTranscription = {
        ...capabilities.aiTranscription,
        transcribeFile: jest.fn().mockImplementation(transcribeFileImpl || (() => Promise.resolve())),
    };
}

module.exports = {
    stubEnvironment,
    stubLogger,
    stubAiTranscriber,
    stubNotifier,
    stubSleeper,
    stubDatetime,
    stubEventLogRepository,
    stubApp,
    stubGit,
    stubTranscription,
    getDatetimeControl,
};
