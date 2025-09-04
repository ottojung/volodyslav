/**
 * Test for the new datetime mocking functionality.
 */

const { stubDatetime, getDatetimeControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { fromISOString, fromMinutes, fromHours } = require("../src/datetime");

describe("datetime mocking", () => {
    describe("DateTime/Duration API", () => {
        test("should allow setting and getting specific time with DateTime", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const specificDateTime = fromISOString("2021-01-01T00:00:00.000Z");
            
            control.setDateTime(specificDateTime);
            const result = control.getCurrentDateTime();
            expect(result.toISOString()).toBe(specificDateTime.toISOString());
            
            const dateTime = capabilities.datetime.now();
            expect(dateTime.toISOString()).toBe(specificDateTime.toISOString());
        });

        test("should allow advancing time with Duration", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const startDateTime = fromISOString("2021-01-01T00:00:00.000Z");
            const advanceDuration = fromMinutes(1); // 1 minute
            
            control.setDateTime(startDateTime);
            control.advanceByDuration(advanceDuration);
            
            const result = control.getCurrentDateTime();
            const expectedDateTime = startDateTime.advance(advanceDuration);
            expect(result.toISOString()).toBe(expectedDateTime.toISOString());
        });

        test("should support complex duration operations", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const startDateTime = fromISOString("2021-01-01T00:00:00.000Z");
            
            control.setDateTime(startDateTime);
            
            // Advance by different duration types
            control.advanceByDuration(fromMinutes(30)); // 30 minutes
            control.advanceByDuration(fromHours(2));   // 2 hours
            
            const result = control.getCurrentDateTime();
            const expectedDateTime = startDateTime.advance(fromMinutes(30)).advance(fromHours(2));
            expect(result.toISOString()).toBe(expectedDateTime.toISOString());
        });
    });

    describe("General functionality", () => {
        test("should work with capabilities stubbing", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            expect(capabilities.datetime.__isMockedDatetime).toBe(true);
            
            const control = getDatetimeControl(capabilities);
            const specificDateTime = fromISOString("2021-01-01T00:00:00.000Z");
            
            control.setDateTime(specificDateTime);
            const result = control.getCurrentDateTime();
            expect(result.toISOString()).toBe(specificDateTime.toISOString());
            
            // Verify the datetime capability sees the mocked time
            const now = capabilities.datetime.now();
            expect(now.toISOString()).toBe(specificDateTime.toISOString());
        });

        test("should advance time and reflect in datetime operations", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const control = getDatetimeControl(capabilities);
            const startDateTime = fromISOString("2021-01-01T00:00:00.000Z");
            const advanceDuration = fromMinutes(10); // 10 minutes
            
            control.setDateTime(startDateTime);
            
            // Get initial time
            const initialTime = capabilities.datetime.now();
            expect(initialTime.toISOString()).toBe(startDateTime.toISOString());
            
            // Advance time
            control.advanceByDuration(advanceDuration);
            
            // Verify time advanced
            const laterTime = capabilities.datetime.now();
            const expectedDateTime = startDateTime.advance(advanceDuration);
            expect(laterTime.toISOString()).toBe(expectedDateTime.toISOString());
        });

        test("should throw error when accessing control without stubbing", () => {
            const capabilities = getMockedRootCapabilities();
            // Don't stub datetime
            
            expect(() => getDatetimeControl(capabilities)).toThrow(/must be stubbed/);
        });

        test("should support jest mock functions on datetime.now", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const specificDateTime = fromISOString("2021-01-01T00:00:00.000Z");
            
            // Test that datetime.now is still a jest mock that supports mockReturnValue
            capabilities.datetime.now.mockReturnValue(specificDateTime);
            
            const result = capabilities.datetime.now();
            expect(result.toISOString()).toBe(specificDateTime.toISOString());
            expect(capabilities.datetime.now).toHaveBeenCalled();
        });

        test("should support jest mock functions with mockReturnValueOnce", () => {
            const capabilities = getMockedRootCapabilities();
            stubDatetime(capabilities);
            
            const dateTime1 = fromISOString("2021-01-01T00:00:00.000Z");
            const dateTime2 = fromISOString("2021-01-02T00:00:00.000Z"); // Jan 2, 2021 00:00:00 UTC
            
            capabilities.datetime.now
                .mockReturnValueOnce(dateTime1)
                .mockReturnValueOnce(dateTime2);
            
            const result1 = capabilities.datetime.now();
            const result2 = capabilities.datetime.now();
            
            expect(result1.toISOString()).toBe(dateTime1.toISOString());
            expect(result2.toISOString()).toBe(dateTime2.toISOString());
        });
    });
});