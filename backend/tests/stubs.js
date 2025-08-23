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
    // Store the original datetime methods that are already jest mocks
    const originalNow = capabilities.datetime.now;
    
    // Initialize with current real time, but this can be overridden
    let currentTimeMs = Date.now();
    
    // Override the now method to return the controlled time
    originalNow.mockImplementation(() => capabilities.datetime.fromEpochMs(currentTimeMs));
    
    // Add time control methods to the datetime object
    capabilities.datetime.setTime = (ms) => {
        currentTimeMs = ms;
    };
    
    capabilities.datetime.advanceTime = (ms) => {
        currentTimeMs += ms;
    };
    
    capabilities.datetime.getCurrentTime = () => {
        return currentTimeMs;
    };
    
    // Mark it as mocked for type guard
    capabilities.datetime.__isMockedDatetime = true;
}

/**
 * Provides access to datetime manipulation functions when datetime is stubbed.
 * @param {any} capabilities - The capabilities object with stubbed datetime
 * @returns {{setTime: (ms: number) => void, advanceTime: (ms: number) => void, getCurrentTime: () => number}}
 */
function getDatetimeControl(capabilities) {
    if (!capabilities.datetime.__isMockedDatetime) {
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

/**
 * In-memory implementation of RuntimeStateStorage for testing.
 * Provides the same interface but keeps state in memory instead of persisting to disk.
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
     * In-memory storage reference.
     * @private
     * @type {Map<string, import('../src/runtime_state_storage/types').RuntimeState>}
     */
    storage;

    /**
     * Storage key for this instance.
     * @private
     * @type {string}
     */
    storageKey;

    /**
     * @constructor
     * @param {import('../src/runtime_state_storage/types').RuntimeStateStorageCapabilities} capabilities
     * @param {Map<string, import('../src/runtime_state_storage/types').RuntimeState>} storage
     * @param {string} storageKey
     */
    constructor(capabilities, storage, storageKey) {
        this.capabilities = capabilities;
        this.storage = storage;
        this.storageKey = storageKey;
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
     * Gets the existing runtime state from in-memory storage
     * @returns {Promise<import('../src/runtime_state_storage/types').RuntimeState|null>}
     */
    async getExistingState() {
        return this.storage.get(this.storageKey) || null;
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

        // Create default state if none exists
        const structure = require("../src/runtime_state_storage/structure");
        return structure.makeDefault(this.capabilities.datetime);
    }
}

/**
 * Global in-memory storage for mock runtime state.
 * @type {Map<string, import('../src/runtime_state_storage/types').RuntimeState>}
 */
const mockRuntimeStateStorage = new Map();

/**
 * Mock implementation of runtime state storage transaction.
 * Provides the same interface as the real transaction but keeps everything in memory.
 * 
 * @template T
 * @param {import('../src/runtime_state_storage/types').RuntimeStateStorageCapabilities} capabilities
 * @param {(storage: any) => Promise<T>} transformation
 * @returns {Promise<T>}
 */
async function mockRuntimeStateTransaction(capabilities, transformation) {
    const storageKey = "mock-runtime-state";
    const mockStorage = new MockRuntimeStateStorageClass(capabilities, mockRuntimeStateStorage, storageKey);
    
    // Run the transformation
    const result = await transformation(mockStorage);
    
    // Handle state changes - persist to in-memory storage
    const newState = mockStorage.getNewState();
    if (newState !== null) {
        mockRuntimeStateStorage.set(storageKey, newState);
    }
    
    return result;
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
 * This replaces expensive git operations with fast in-memory operations.
 * 
 * @param {any} capabilities - Capabilities object to modify
 */
function stubRuntimeStateStorage(capabilities) {
    // Clear any previous mock state
    mockRuntimeStateStorage.clear();
    
    // Mock the state capability to use our in-memory implementation
    capabilities.state = {
        transaction: jest.fn().mockImplementation((transformation) => mockRuntimeStateTransaction(capabilities, transformation)),
        ensureAccessible: jest.fn().mockResolvedValue(undefined),
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
    stubRuntimeStateStorage,
    getDatetimeControl,
    mockRuntimeStateTransaction,
    isMockRuntimeStateStorage,
};
