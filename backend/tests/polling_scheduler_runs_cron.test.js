const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");

function createCapabilities() {
    return {
        logger: {
            logInfo: jest.fn(),
            logDebug: jest.fn(),
            logWarning: jest.fn(),
            logError: jest.fn(),
        },
        datetime: {
            fromEpochMs: (ms) => ({ epochMs: ms }),
            fromISOString: (iso) => ({ epochMs: new Date(iso).getTime() }),
            toNativeDate: (dt) => new Date(dt.epochMs),
        },
        // Mock storage capabilities to prevent transaction failures
        environment: {
            get: jest.fn().mockReturnValue('/tmp/test'),
        },
        creator: {
            createFile: jest.fn(),
            createDirectory: jest.fn(),
        },
        checker: {
            fileExists: jest.fn().mockResolvedValue(false),
        },
        writer: {
            writeFile: jest.fn(),
        },
        reader: {
            readFile: jest.fn().mockResolvedValue('{}'),
        },
        git: {
            run: jest.fn().mockResolvedValue({ success: true }),
        },
    };
}

describe("polling scheduler runs cron", () => {
    test("executes once per minute", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const capabilities = createCapabilities();
        const cron = make(capabilities, { pollIntervalMs: 10 });
        const cb = jest.fn();
        const retryDelay = fromMilliseconds(0);
        await cron.schedule("t", "* * * * *", cb, retryDelay);

        console.log('Scheduled at', new Date().toISOString());
        
        jest.advanceTimersByTime(10);
        console.log('After first poll, calls:', cb.mock.calls.length);
        expect(cb).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(20);
        console.log('After second poll, calls:', cb.mock.calls.length);
        expect(cb).toHaveBeenCalledTimes(1);

        console.log('Advancing time by 60 seconds');
        jest.advanceTimersByTime(60000);
        console.log('After time advance, calls:', cb.mock.calls.length);
        expect(cb).toHaveBeenCalledTimes(2);

        await cron.cancelAll();
    });
});

