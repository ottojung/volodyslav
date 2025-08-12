const { make, validate, ScheduleInvalidNameError } = require("../src/cron");
const { fromMilliseconds, COMMON } = require("../src/time_duration");

function caps() {
    return {
        logger: {
            logInfo: jest.fn(),
            logDebug: jest.fn(),
            logWarning: jest.fn(),
            logError: jest.fn(),
        },
    };
}

describe("polling scheduler validate() and getTasks()", () => {
    test("validate exposes parser and returns booleans", () => {
        expect(validate("* * * * *")).toBe(true);
        expect(validate("0 2 * * *")).toBe(true);
        expect(validate("60 * * * *")).toBe(false); // invalid minute
        expect(validate(/** @type any */(null))).toBe(false);
    });

    test("throws on invalid task name (empty/whitespace)", () => {
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(0);
        expect(() => cron.schedule("", "* * * * *", () => {}, retryDelay)).toThrow(ScheduleInvalidNameError);
        expect(() => cron.schedule("   ", "* * * * *", () => {}, retryDelay)).toThrow(ScheduleInvalidNameError);
        cron.cancelAll();
    });

    test("getTasks modeHint shows cron when due, idle otherwise", () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = COMMON.ONE_MINUTE;
        const cb = jest.fn();
        cron.schedule("t", "* * * * *", cb, retryDelay);

        // before first poll, not run yet -> after first poll it should run once
        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(1);
        const tasksAfterRun = cron.getTasks();
        expect(tasksAfterRun[0].modeHint).toBe("idle"); // just ran and success

        // advance less than a minute -> still idle
        jest.advanceTimersByTime(20000);
        expect(cron.getTasks()[0].modeHint).toBe("idle");

        // Jump system time to the next minute without ticking the poller yet
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        expect(cron.getTasks()[0].modeHint).toBe("cron");

        // Next poll triggers the cron execution
        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(2);
        expect(cron.getTasks()[0].modeHint).toBe("idle");

        cron.cancelAll();
    });

    test("getTasks modeHint shows retry when pending and due", () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(100);
        let first = true;
        const cb = jest.fn(() => {
            if (first) { first = false; throw new Error("boom"); }
        });
        cron.schedule("t", "* * * * *", cb, retryDelay);

        // First poll -> fails and schedules retry
        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cron.getTasks()[0].modeHint).toBe("idle"); // retry not yet due

        // Before retry due
        jest.advanceTimersByTime(90);
        expect(cron.getTasks()[0].modeHint).toBe("idle");

        // After retry due, but before the poll tick executes it, the hint should be retry
        jest.setSystemTime(new Date("2020-01-01T00:00:00.200Z"));
        expect(cron.getTasks()[0].modeHint).toBe("retry");

        // Next poll triggers retry and succeeds
        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(2);
        expect(cron.getTasks()[0].modeHint).toBe("idle");

        cron.cancelAll();
    });

    test("cancel of non-existent task returns false and keeps others", () => {
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(0);
        cron.schedule("a", "* * * * *", () => {}, retryDelay);
        expect(cron.cancel("missing")).toBe(false);
        expect(cron.getTasks().length).toBe(1);
        cron.cancelAll();
    });
});
