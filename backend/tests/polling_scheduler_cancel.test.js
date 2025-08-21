const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubGit } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubGit(capabilities);
    return capabilities;
}

describe("polling scheduler cancel", () => {
    test("cancel and cancelAll remove tasks", async () => {
        jest.useFakeTimers();
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(0);
        await cron.schedule("a", "* * * * *", () => {}, retryDelay);
        await cron.schedule("b", "* * * * *", () => {}, retryDelay);
        expect((await cron.getTasks()).length).toBe(2);
        expect(await cron.cancel("a")).toBe(true);
        expect((await cron.getTasks()).length).toBe(1);
        await cron.schedule("c", "* * * * *", () => {}, retryDelay);
        expect(await cron.cancelAll()).toBe(2);
        expect((await cron.getTasks()).length).toBe(0);
    });
});

