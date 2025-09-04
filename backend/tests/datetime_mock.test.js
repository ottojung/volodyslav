/**
 * Test for the new datetime mocking functionality.
 */

const { DateTime } = require("luxon");
const { stubDatetime, getDatetimeControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { toEpochMs, fromEpochMs, fromMinutes, fromHours, difference } = require("../src/datetime");

describe("datetime mocking", () => {
    describe("DateTime/Duration API", () => {
        test("should allow setting and getting specific time with DateTime", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const specificDateTime = fromEpochMs(DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis());
            
            control.setDateTime(specificDateTime);
            const result = control.getCurrentDateTime();
            expect(toEpochMs(result)).toBe(toEpochMs(specificDateTime));
            
            const dateTime = capabilities.datetime.now();
            expect(toEpochMs(dateTime)).toBe(toEpochMs(specificDateTime));
        });

        test("should allow advancing time with Duration", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const startDateTime = fromEpochMs(DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis());
            const advanceDuration = fromMinutes(1); // 1 minute
            
            control.setDateTime(startDateTime);
            control.advanceByDuration(advanceDuration);
            
            const result = control.getCurrentDateTime();
            const expectedTime = toEpochMs(startDateTime) + (60 * 1000); // 1 minute in ms
            expect(toEpochMs(result)).toBe(expectedTime);
        });

        test("should support complex duration operations", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const startDateTime = fromEpochMs(DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis());
            
            control.setDateTime(startDateTime);
            
            // Advance by different duration types
            control.advanceByDuration(fromMinutes(30)); // 30 minutes
            control.advanceByDuration(fromHours(2));   // 2 hours
            
            const result = control.getCurrentDateTime();
            const expectedAdvance = fromMinutes(30).plus(fromHours(2)); // 30 min + 2 hours 
            const actualAdvance = difference(result, startDateTime);
            expect(actualAdvance.as('milliseconds')).toBe(expectedAdvance.as('milliseconds'));
        });
    });

    describe("General functionality", () => {
        test("should work with capabilities stubbing", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            expect(capabilities.datetime.__isMockedDatetime).toBe(true);
            
            const control = getDatetimeControl(capabilities);
            const specificDateTime = fromEpochMs(DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis());
            
            control.setDateTime(specificDateTime);
            const result = control.getCurrentDateTime();
            expect(toEpochMs(result)).toBe(toEpochMs(specificDateTime));
            
            // Verify the datetime capability sees the mocked time
            const now = capabilities.datetime.now();
            const epochMs = toEpochMs(now);
            expect(epochMs).toBe(toEpochMs(specificDateTime));
        });

        test("should advance time and reflect in datetime operations", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const startDateTime = fromEpochMs(DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis());
            const advanceDuration = fromMinutes(10); // 10 minutes
            
            control.setDateTime(startDateTime);
            
            // Get initial time
            const initialTime = capabilities.datetime.now();
            expect(toEpochMs(initialTime)).toBe(toEpochMs(startDateTime));
            
            // Advance time
            control.advanceByDuration(advanceDuration);
            
            // Verify time advanced correctly
            const laterTime = capabilities.datetime.now();
            const actualAdvance = difference(laterTime, initialTime);
            expect(actualAdvance.as('minutes')).toBe(10);
        });

        test("should throw error when accessing control without stubbing", () => {
            const capabilities = getMockedRootCapabilities();
            // Don't stub datetime
            
            expect(() => getDatetimeControl(capabilities)).toThrow(/must be stubbed/);
        });

        test("should support jest mock functions on datetime.now", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const specificDateTime = fromEpochMs(DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis());
            
            // Test that datetime.now is still a jest mock that supports mockReturnValue
            capabilities.datetime.now.mockReturnValue(specificDateTime);
            
            const result = capabilities.datetime.now();
            expect(toEpochMs(result)).toBe(toEpochMs(specificDateTime));
            expect(capabilities.datetime.now).toHaveBeenCalled();
        });

        test("should support jest mock functions with mockReturnValueOnce", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const dateTime1 = fromEpochMs(DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis());
            const dateTime2 = fromEpochMs(1609545600000); // Jan 2, 2021 00:00:00 UTC
            
            capabilities.datetime.now
                .mockReturnValueOnce(dateTime1)
                .mockReturnValueOnce(dateTime2);
            
            const result1 = capabilities.datetime.now();
            const result2 = capabilities.datetime.now();
            
            expect(toEpochMs(result1)).toBe(toEpochMs(dateTime1));
            expect(toEpochMs(result2)).toBe(toEpochMs(dateTime2));
        });
    });
});