const path = require("path");
const fs = require("fs");
const os = require("os");
const { stubEventLogRepository } = require("./stub_event_log_repository");
const { POLLING_LOOP_NAME } = require("../src/scheduler/polling/identifiers");

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
    capabilities.environment.generatorsRepository = jest
        .fn()
        .mockImplementation(() => {
            const dir = output;
            return path.join(dir, "generators-remote");
        });
    capabilities.environment.eventLogAssetsDirectory = jest
        .fn()
        .mockImplementation(() => {
            const dir = output;
            return path.join(dir, "assets");
        });
    capabilities.environment.eventLogAssetsRepository = jest
        .fn()
        .mockImplementation(() => {
            const dir = output;
            return path.join(dir, "assets-remote");
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
    capabilities.environment.geminiApiKey = jest
        .fn()
        .mockReturnValue("mocked-gemini-key");
    capabilities.environment.myServerPort = jest.fn().mockReturnValue(1234);
    capabilities.environment.hostname = jest
        .fn()
        .mockReturnValue("test-host");
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
        .mockResolvedValue("This is a mocked transcription result for automated testing purposes");
    capabilities.aiTranscription.transcribeStreamDetailed = jest
        .fn()
        .mockResolvedValue({
            text: "This is a mocked transcription result for automated testing purposes",
            provider: "Google",
            model: "mocked-transcriber",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 10,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: {
                transcript: "This is a mocked transcription result for automated testing purposes",
                coverage: "full",
                warnings: [],
                unclearAudio: false,
            },
            rawResponse: null,
        });
    capabilities.aiTranscription.transcribeStreamPrecise = jest
        .fn()
        .mockResolvedValue("This is a mocked transcription result for automated testing purposes");
    capabilities.aiTranscription.transcribeStreamPreciseDetailed = jest
        .fn()
        .mockResolvedValue({
            text: "This is a mocked transcription result for automated testing purposes",
            provider: "OpenAI",
            model: "whisper-1",
            finishReason: null,
            finishMessage: null,
            candidateTokenCount: null,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: {
                transcript: "This is a mocked transcription result for automated testing purposes",
                coverage: "full",
                warnings: [],
                unclearAudio: false,
            },
            rawResponse: null,
        });
    capabilities.aiTranscription.getTranscriberInfo = jest.fn().mockReturnValue({
        name: "mocked-transcriber",
        creator: "Mocked Creator",
    });
}

/**
 * Stubs the AI diary questions capabilities for testing.
 * @param {object} capabilities
 */
function stubAiDiaryQuestions(capabilities) {
    capabilities.aiDiaryQuestions.generateQuestions = jest
        .fn()
        .mockResolvedValue([
            { text: "What part of today felt most meaningful?", intent: "warm_reflective" },
            { text: "How did that experience make you feel?", intent: "warm_reflective" },
            { text: "Can you tell me more about what happened?", intent: "clarifying" },
            { text: "What details do you want to remember later?", intent: "clarifying" },
            { text: "What small step feels right from here?", intent: "forward" },
        ]);
}

/**
 * Stubs the AI diary summary capabilities for testing.
 * By default returns the current summary markdown unchanged (passthrough).
 * @param {object} capabilities
 */
function stubAiDiarySummary(capabilities) {
    capabilities.aiDiarySummary.updateSummary = jest
        .fn()
        .mockImplementation(({ currentSummaryMarkdown }) =>
            Promise.resolve({ summaryMarkdown: currentSummaryMarkdown + "\n- updated" })
        );
}


/**
 * Stubs the AI transcript recombination capabilities for testing.
 * By default returns the newWindowText unchanged (passthrough).
 * @param {object} capabilities
 */
function stubAiTranscriptRecombination(capabilities) {
    capabilities.aiTranscriptRecombination.recombineOverlap = jest
        .fn()
        .mockImplementation((_existingOverlapText, newWindowText) =>
            Promise.resolve(newWindowText)
        );
}


/**
 * @param {object} capabilities
 * @param {number | 'N/A'} [defaultCalories='N/A'] - The default calorie count to return for any event/context pair, or 'N/A' for unavailable
 */
function stubAiCalories(capabilities, defaultCalories = "N/A") {
    capabilities.aiCalories.estimateCalories = jest
        .fn()
        .mockResolvedValue(defaultCalories);
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

function stubDailyTasksExecutable(capabilities) {
    capabilities.volodyslavDailyTasks.ensureAvailable = jest.fn().mockResolvedValue(true);
}

function stubSleeper(capabilities) {
    const original = capabilities.sleeper;   
    const withMutex = original.withMutex; 
    const withModeMutex = original.withModeMutex;

    const sleep = jest.fn().mockImplementation(async (_name, _duration) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
    });

    const makeSleeper = jest.fn().mockImplementation((_name) => {
        /** @type {NodeJS.Timeout | undefined} */
        let timeout = undefined;
        /** @type {undefined | ((value: unknown) => void)} */
        let savedResolve = undefined;

        /**
         * @param {import('../src/datetime').Duration} duration
         */
        async function sleep(_duration) {
            await new Promise((resolve) => {
                savedResolve = resolve;
                timeout = setTimeout(resolve, 1);
            });
        }

        function wake() {
            clearTimeout(timeout);
            savedResolve?.(0);
        }

        return { sleep, wake };
    });

    capabilities.sleeper = {
        sleep,
        makeSleeper,
        withMutex,
        withModeMutex,
    };
}

const datetime = require("../src/datetime");

function stubDatetime(capabilities) {
    // Store the original datetime methods that are already jest mocks
    const originalNow = capabilities.datetime.now;

    // Initialize with a fixed time for tests (January 1, 2024 00:00:00 UTC)
    let currentDateTime = datetime.fromISOString("2024-01-01T00:00:00.000Z");

    // Override the now method to return the controlled time
    originalNow.mockImplementation(() => currentDateTime);
    capabilities.datetime.timeZone = () => "UTC";

    // DateTime/Duration-only API - no milliseconds support
    capabilities.datetime.setDateTime = (dateTime) => {
        currentDateTime = dateTime;
    };

    capabilities.datetime.advanceByDuration = (duration) => {
        currentDateTime = currentDateTime.advance(duration);
    };

    capabilities.datetime.getCurrentDateTime = () => {
        return currentDateTime;
    };

    // Mark it as mocked for type guard
    capabilities.datetime.__isMockedDatetime = true;
}

/**
 * Provides access to datetime manipulation functions when datetime is stubbed.
 * Works only with DateTime/Duration objects - no milliseconds support.
 * @param {any} capabilities - The capabilities object with stubbed datetime
 * @returns {{setDateTime: (dateTime: import('../src/datetime').DateTime) => void, advanceByDuration: (duration: import('../src/datetime').Duration) => void, getCurrentDateTime: () => import('../src/datetime').DateTime}}
 */
function getDatetimeControl(capabilities) {
    if (!capabilities.datetime.__isMockedDatetime) {
        throw new Error("Datetime must be stubbed with stubDatetime() to use datetime control");
    }
    return {
        // DateTime/Duration-only API
        setDateTime: (dateTime) => capabilities.datetime.setDateTime(dateTime),
        advanceByDuration: (duration) => capabilities.datetime.advanceByDuration(duration),
        getCurrentDateTime: () => capabilities.datetime.getCurrentDateTime(),
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

/**
 * In-memory implementation of RuntimeStateStorage for testing.
 * Provides the same interface but keeps state in memory instead of persisting to disk.
 * Captures the existing state at construction time (transaction start snapshot).
 */
class MockRuntimeStateStorageClass {
    /**
     * New runtime state to be written.
     * @private
     * @type {import('../src/runtime_state_storage/types').RuntimeState|null}
     */
    newState = null;

    /**
     * Capabilities object for operations.
     * @private
     * @type {import('../src/runtime_state_storage/types').RuntimeStateStorageCapabilities}
     */
    capabilities;

    /**
     * Snapshot of the existing state captured at transaction start.
     * @private
     * @type {import('../src/runtime_state_storage/types').RuntimeState|null}
     */
    _existingState;

    /**
     * @constructor
     * @param {import('../src/runtime_state_storage/types').RuntimeStateStorageCapabilities} capabilities
     * @param {Map<string, import('../src/runtime_state_storage/types').RuntimeState>} storage
     * @param {string} storageKey
     */
    constructor(capabilities, storage, storageKey) {
        this.capabilities = capabilities;
        this._existingState = storage.get(storageKey) ?? null;
    }

    /**
     * Sets a new runtime state to be written
     * @param {import('../src/runtime_state_storage/types').RuntimeState} state
     */
    setState(state) {
        this.newState = state;
    }

    /**
     * Gets the new runtime state to be written
     * @returns {import('../src/runtime_state_storage/types').RuntimeState|null}
     */
    getNewState() {
        return this.newState;
    }

    /**
     * Gets the existing runtime state from the snapshot captured at transaction start.
     * @returns {Promise<import('../src/runtime_state_storage/types').RuntimeState|null>}
     */
    async getExistingState() {
        return this._existingState;
    }

    /**
     * Gets the current runtime state, either from what's been set in this transaction
     * or from the existing state. If neither exists, creates a default state.
     * @returns {Promise<import('../src/runtime_state_storage/types').RuntimeState>}
     */
    async getCurrentState() {
        if (this.newState !== null) {
            return this.newState;
        }

        const existing = await this.getExistingState();
        if (existing !== null) {
            return existing;
        }

        const structure = require("../src/runtime_state_storage/structure");
        return structure.makeDefault(this.capabilities.datetime);
    }
}

/**
 * Mock implementation of runtime state storage transaction.
 * Provides the same interface as the real transaction but keeps everything in memory.
 * Works with a minimal capabilities object (e.g. just { datetime, logger }) — it does
 * NOT require capabilities.state to be set up.  State is persisted between calls via
 * capabilities._mockRuntimeStateMap (lazily initialised).  Transactions are serialised
 * via a promise-chain mutex stored in capabilities._mockRuntimeStateMutex.
 *
 * @template T
 * @param {import('../src/runtime_state_storage/types').RuntimeStateStorageCapabilities} capabilities
 * @param {(storage: any) => Promise<T>} transformation
 * @returns {Promise<T>}
 */
async function mockRuntimeStateTransaction(capabilities, transformation) {
    // Lazily initialise mutex and storage on the capabilities object.
    if (capabilities._mockRuntimeStateMutex === undefined) {
        capabilities._mockRuntimeStateMutex = Promise.resolve();
    }
    if (capabilities._mockRuntimeStateMap === undefined) {
        capabilities._mockRuntimeStateMap = new Map();
    }

    /** @type {(value?: unknown) => void} */
    let release;
    const acquired = new Promise((resolve) => { release = resolve; });
    const prev = capabilities._mockRuntimeStateMutex;
    capabilities._mockRuntimeStateMutex = acquired;

    // Wait for the previous transaction to finish (serialise via mutex).
    await prev;

    const storageKey = "mock-runtime-state";
    const mockStorage = new MockRuntimeStateStorageClass(
        capabilities,
        capabilities._mockRuntimeStateMap,
        storageKey,
    );

    try {
        const result = await transformation(mockStorage);

        // Only persist if the transformation called setState.
        const newState = mockStorage.getNewState();
        if (newState !== null) {
            capabilities._mockRuntimeStateMap.set(storageKey, newState);
        }

        return result;
    } finally {
        // Always release the mutex, even if transformation threw.
        release();
    }
}

/**
 * Type guard for mock RuntimeStateStorage.
 * @param {unknown} object
 * @returns {object is MockRuntimeStateStorageClass}
 */
function isMockRuntimeStateStorage(object) {
    return object instanceof MockRuntimeStateStorageClass;
}

/**
 * Stubs the runtime state storage with in-memory implementation.
 * Initialises capabilities._mockRuntimeStateMap and capabilities._mockRuntimeStateMutex
 * and wires capabilities.state.transaction to use the in-memory mock.
 *
 * @param {any} capabilities - Capabilities object to modify
 */
function stubRuntimeStateStorage(capabilities) {
    // Lazily initialise shared mutex + storage so that mockRuntimeStateTransaction
    // and capabilities.state.transaction share the same in-memory state.
    if (capabilities._mockRuntimeStateMutex === undefined) {
        capabilities._mockRuntimeStateMutex = Promise.resolve();
    }
    if (capabilities._mockRuntimeStateMap === undefined) {
        capabilities._mockRuntimeStateMap = new Map();
    }

    capabilities.state = {
        transaction: jest.fn().mockImplementation((transformation) => mockRuntimeStateTransaction(capabilities, transformation)),
        ensureAccessible: jest.fn().mockResolvedValue(undefined),
    };
}

function stubScheduler(capabilities) {
    const originalMakeSleeper = capabilities.sleeper.makeSleeper;
    let cycleCount = 0;
    let durationOverride = null;

    function setPollingInterval(newDuration) {
        durationOverride = newDuration;
    }

    async function waitForNextCycleEnd() {
        const originalCount = cycleCount;
        while (originalCount >= cycleCount) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    }

    capabilities._stubbedScheduler = {
        setPollingInterval,
        waitForNextCycleEnd,
    };

    function fakeSleeper(_name) {
        /** @type {NodeJS.Timeout | undefined} */
        let timeout = undefined;
        /** @type {undefined | ((value: unknown) => void)} */
        let savedResolve = undefined;

        /**
         * @param {import('../src/datetime').Duration} duration
         */
        async function sleep(duration) {
            if (durationOverride !== null) {
                duration = durationOverride;
            }

            await new Promise((resolve) => {
                savedResolve = resolve;
                timeout = setTimeout(resolve, duration.toMillis());
            });

            cycleCount++;
        }

        function wake() {
            clearTimeout(timeout);
            savedResolve?.(0);
        }

        return { sleep, wake };
    }    

    function makeSleeper(name) {
        if (name === POLLING_LOOP_NAME) {
            return fakeSleeper(name);
        } else {
            return originalMakeSleeper(name);
        }
    }

    capabilities.sleeper.makeSleeper = jest.fn().mockImplementation(makeSleeper);
}

/**
 * @typedef {object} SchedulerControl
 * @property { (newPeriod: import('../src/datetime').Duration) => void } setPollingInterval
 * @property {import('../src/threading').PeriodicThread} thread
 * @property {() => Promise<void>} waitForNextCycleEnd
 */

/**
 * @returns {SchedulerControl}
 */
function getSchedulerControl(capabilities) {
    if (capabilities._stubbedScheduler === undefined) {
        throw new Error("Scheduler must be stubbed with stubScheduler() to use scheduler control");
    }
    return capabilities._stubbedScheduler;
}

function stubWifiChecker(capabilities) {
    capabilities.wifiChecker.ensureAvailable = jest.fn();
    capabilities.wifiChecker.isConnected = jest.fn().mockResolvedValue(true);
    capabilities.wifiChecker.getConnectionInfo = jest
        .fn()
        .mockResolvedValue({
            ssid: "MockedSSID",
            bssid: "00:11:22:33:44:55",
            ipAddress: "192.168.1.1",
        });
}

function stubRsync(capabilities) {
    capabilities.rsync.ensureAvailable = jest.fn().mockResolvedValue(undefined);
}

module.exports = {
    stubEnvironment,
    stubLogger,
    stubAiTranscriber,
    stubAiCalories,
    stubAiDiaryQuestions,
    stubAiDiarySummary,
    stubAiTranscriptRecombination,
    stubNotifier,
    stubDailyTasksExecutable,
    stubSleeper,
    stubDatetime,
    stubEventLogRepository,
    stubApp,
    stubGit,
    stubTranscription,
    stubRuntimeStateStorage,
    getDatetimeControl,
    getSchedulerControl,
    stubScheduler,
    mockRuntimeStateTransaction,
    isMockRuntimeStateStorage,
    stubWifiChecker,
    stubRsync,
};
