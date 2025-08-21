/**
 * Test for the new datetime mocking functionality.
 */

const { makeMockedDatetime, isMockedDatetime } = require("../src/datetime_mock");
const { stubDatetime, getDatetimeControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");

describe("datetime mocking", () => {
    test("should create a mocked datetime instance", () => {
        const mockedDatetime = makeMockedDatetime();
        expect(isMockedDatetime(mockedDatetime)).toBe(true);
    });

    test("should allow setting and getting specific time", () => {
        const mockedDatetime = makeMockedDatetime();
        const specificTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        
        mockedDatetime.setTime(specificTime);
        expect(mockedDatetime.getCurrentTime()).toBe(specificTime);
        
        const dateTime = mockedDatetime.now();
        expect(mockedDatetime.toEpochMs(dateTime)).toBe(specificTime);
    });

    test("should allow advancing time", () => {
        const mockedDatetime = makeMockedDatetime();
        const startTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        const advanceMs = 60 * 1000; // 1 minute
        
        mockedDatetime.setTime(startTime);
        mockedDatetime.advanceTime(advanceMs);
        
        expect(mockedDatetime.getCurrentTime()).toBe(startTime + advanceMs);
    });

    test("should work with capabilities stubbing", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        expect(isMockedDatetime(capabilities.datetime)).toBe(true);
        
        const control = getDatetimeControl(capabilities);
        const specificTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        
        control.setTime(specificTime);
        expect(control.getCurrentTime()).toBe(specificTime);
        
        // Verify the datetime capability sees the mocked time
        const now = capabilities.datetime.now();
        const nativeDate = capabilities.datetime.toNativeDate(now);
        expect(nativeDate.getTime()).toBe(specificTime);
    });

    test("should advance time and reflect in datetime operations", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        
        const control = getDatetimeControl(capabilities);
        const startTime = 1609459200000; // Jan 1, 2021 00:00:00 UTC
        const advanceMs = 10 * 60 * 1000; // 10 minutes
        
        control.setTime(startTime);
        
        // Get initial time
        const initialTime = capabilities.datetime.toNativeDate(capabilities.datetime.now());
        expect(initialTime.getTime()).toBe(startTime);
        
        // Advance time
        control.advanceTime(advanceMs);
        
        // Verify time advanced
        const laterTime = capabilities.datetime.toNativeDate(capabilities.datetime.now());
        expect(laterTime.getTime()).toBe(startTime + advanceMs);
        expect(laterTime.getTime() - initialTime.getTime()).toBe(advanceMs);
    });

    test("should throw error when accessing control without stubbing", () => {
        const capabilities = getMockedRootCapabilities();
        // Don't stub datetime
        
        expect(() => getDatetimeControl(capabilities)).toThrow(/must be stubbed/);
    });
});