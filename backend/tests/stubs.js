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
}

/**
 * Stubs the logger capabilities for testing.
 * Silences all logging functions.
 */
function stubLogger(capabilities) {
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

/**
 * Stubs the scheduler capabilities for testing.
 * Mocks the schedule function to prevent real timers from being created.
 */
function stubScheduler(capabilities) {
    // Mock scheduler instance methods - all operations are now async
    const mockSchedulerInstance = {
        schedule: jest.fn((name) => Promise.resolve(name)),
        cancel: jest.fn().mockResolvedValue(true),
        cancelAll: jest.fn().mockResolvedValue(0),
        getTasks: jest.fn().mockResolvedValue([])
    };
    
    // Attach the mock to capabilities for testing
    capabilities.scheduler = mockSchedulerInstance;
}

function stubSleeper(capabilities) {
    capabilities.sleeper.sleep = jest.fn().mockImplementation((_ms) => {
        return Promise.resolve(); // Immediately resolve when stubbed
    });
}

function stubDatetime(capabilities) {
    // Create a full datetime mock that works with Jest fake timers
    const originalDatetime = capabilities.datetime;
    capabilities.datetime = {
        ...originalDatetime,
        // Use Jest's mocked Date constructor directly instead of Date.now()
        now: jest.fn(() => originalDatetime.fromEpochMs(new Date().getTime())),
        fromEpochMs: originalDatetime.fromEpochMs,
        fromISOString: originalDatetime.fromISOString,
        toEpochMs: originalDatetime.toEpochMs,
        toISOString: originalDatetime.toISOString,
        toNativeDate: originalDatetime.toNativeDate,
    };
}

/**
 * Stubs git-related capabilities to avoid real subprocess execution.
 */
function stubGit(capabilities) {
    if (capabilities.git) {
        capabilities.git.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
        capabilities.git.ensureAvailable = jest.fn().mockResolvedValue(undefined);
    }
    if (capabilities.volodyslavDailyTasks) {
        capabilities.volodyslavDailyTasks.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
        capabilities.volodyslavDailyTasks.ensureAvailable = jest.fn().mockResolvedValue(undefined);
    }
}

module.exports = {
    stubEnvironment,
    stubLogger,
    stubAiTranscriber,
    stubNotifier,
    stubScheduler,
    stubSleeper,
    stubDatetime,
    stubEventLogRepository,
    stubGit,
};
