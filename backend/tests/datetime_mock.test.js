/**
 * Test for the new datetime mocking functionality.
 */

const { stubDatetime, getDatetimeControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { toEpochMs, fromEpochMs } = require("../src/datetime");

describe("datetime mocking", () => {
    test("should allow setting and getting specific time", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        const control = getDatetimeControl(capabilities);
        const specificTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        
        control.setTime(specificTime);
        expect(control.getCurrentTime()).toBe(specificTime);
        
        const dateTime = capabilities.datetime.now();
        expect(toEpochMs(dateTime)).toBe(specificTime);
    });

    test("should allow advancing time", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        const control = getDatetimeControl(capabilities);
        const startTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        const advanceMs = 60 * 1000; // 1 minute
        
        control.setTime(startTime);
        control.advanceTime(advanceMs);
        
        expect(control.getCurrentTime()).toBe(startTime + advanceMs);
    });

    test("should work with capabilities stubbing", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        expect(capabilities.datetime.__isMockedDatetime).toBe(true);
        
        const control = getDatetimeControl(capabilities);
        const specificTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        
        control.setTime(specificTime);
        expect(control.getCurrentTime()).toBe(specificTime);
        
        // Verify the datetime capability sees the mocked time
        const now = capabilities.datetime.now();
        const epochMs = toEpochMs(now);
        expect(epochMs).toBe(specificTime);
    });

    test("should advance time and reflect in datetime operations", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        const control = getDatetimeControl(capabilities);
        const startTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        const advanceMs = 10 * 60 * 1000; // 10 minutes
        
        control.setTime(startTime);
        
        // Get initial time
        const initialTime = capabilities.datetime.now();
        expect(toEpochMs(initialTime)).toBe(startTime);
        
        // Advance time
        control.advanceTime(advanceMs);
        
        // Verify time advanced
        const laterTime = capabilities.datetime.now();
        expect(toEpochMs(laterTime)).toBe(startTime + advanceMs);
        expect(toEpochMs(laterTime) - toEpochMs(initialTime)).toBe(advanceMs);
    });

    test("should throw error when accessing control without stubbing", () => {
        const capabilities = getMockedRootCapabilities();
        // Don't stub datetime
        
        expect(() => getDatetimeControl(capabilities)).toThrow(/must be stubbed/);
    });

    test("should support jest mock functions on datetime.now", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        const specificTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        const specificDateTime = fromEpochMs(specificTime);
        
        // Test that datetime.now is still a jest mock that supports mockReturnValue
        capabilities.datetime.now.mockReturnValue(specificDateTime);
        
        const result = capabilities.datetime.now();
        expect(toEpochMs(result)).toBe(specificTime);
        expect(capabilities.datetime.now).toHaveBeenCalled();
    });

    test("should support jest mock functions with mockReturnValueOnce", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        const time1 = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        const time2 = 1609545600000; // Jan 2, 2021 00:00:00 UTC
        
        const dateTime1 = fromEpochMs(time1);
        const dateTime2 = fromEpochMs(time2);
        
        capabilities.datetime.now
            .mockReturnValueOnce(dateTime1)
            .mockReturnValueOnce(dateTime2);
        
        const result1 = capabilities.datetime.now();
        const result2 = capabilities.datetime.now();
        
        expect(toEpochMs(result1)).toBe(time1);
        expect(toEpochMs(result2)).toBe(time2);
    });
});