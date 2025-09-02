/**
 * Test for weekday string functionality
 */

const { DateTime: LuxonDateTime } = require("luxon");
const { parseCronExpression, matchesCronExpression } = require("../src/scheduler");
const DateTime = require("../src/datetime/structure");
const { getAllWeekdayNames, isWeekdayName, luxonWeekdayToName, weekdayNameToCronNumber } = require("../src/datetime");

describe("Weekday string functionality", () => {
    test("DateTime.weekday should return weekday names", () => {
        const testCases = [
            { date: "2024-01-01T00:00:00Z", expected: "monday" },   // Monday
            { date: "2024-01-02T00:00:00Z", expected: "tuesday" },  // Tuesday
            { date: "2024-01-03T00:00:00Z", expected: "wednesday" }, // Wednesday
            { date: "2024-01-04T00:00:00Z", expected: "thursday" }, // Thursday
            { date: "2024-01-05T00:00:00Z", expected: "friday" },   // Friday
            { date: "2024-01-06T00:00:00Z", expected: "saturday" }, // Saturday
            { date: "2024-01-07T00:00:00Z", expected: "sunday" },   // Sunday
        ];

        testCases.forEach(({ date, expected }) => {
            const luxonDateTime = LuxonDateTime.fromISO(date);
            const dateTime = DateTime.fromLuxon(luxonDateTime);
            expect(dateTime.weekday).toBe(expected);
        });
    });

    test("parseCronExpression should only accept numeric weekday values", () => {
        // Test that numeric values work
        const testCases = [
            { numeric: 0, expected: [0] },      // Sunday
            { numeric: 1, expected: [1] },      // Monday  
            { numeric: 2, expected: [2] },      // Tuesday
            { numeric: 3, expected: [3] },      // Wednesday
            { numeric: 4, expected: [4] },      // Thursday
            { numeric: 5, expected: [5] },      // Friday
            { numeric: 6, expected: [6] },      // Saturday
        ];

        testCases.forEach(({ numeric, expected }) => {
            const cronExpr = parseCronExpression(`* * * * ${numeric}`);
            expect(cronExpr.weekday).toEqual(expected);
        });
    });

    test("parseCronExpression should reject weekday names", () => {
        const weekdayNames = getAllWeekdayNames();

        weekdayNames.forEach((name) => {
            expect(() => parseCronExpression(`* * * * ${name}`)).toThrow();
        });
    });

    test("parseCronExpression should handle wildcard for weekdays", () => {
        const wildcardCron = parseCronExpression("* * * * *");
        expect(wildcardCron.weekday).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    test("weekday utility functions should work correctly", () => {
        // Test isWeekdayName
        expect(isWeekdayName("monday")).toBe(true);
        expect(isWeekdayName("friday")).toBe(true);
        expect(isWeekdayName("invalid")).toBe(false);
        expect(isWeekdayName("Monday")).toBe(false); // Case sensitive
        
        // Test luxonWeekdayToName
        expect(luxonWeekdayToName(1)).toBe("monday");
        expect(luxonWeekdayToName(7)).toBe("sunday");
        expect(() => luxonWeekdayToName(8)).toThrow();
        
        // Test getAllWeekdayNames
        const allNames = getAllWeekdayNames();
        expect(allNames).toEqual(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
        
        // Test weekdayNameToCronNumber
        expect(weekdayNameToCronNumber("sunday")).toBe(0);
        expect(weekdayNameToCronNumber("monday")).toBe(1);
        expect(weekdayNameToCronNumber("saturday")).toBe(6);
    });

    test("matchesCronExpression should work with numeric weekdays and string DateTime.weekday", () => {
        // Test each day of the week
        const testCases = [
            { date: "2024-01-01T12:00:00Z", weekdayName: "monday", cronNumber: 1 },
            { date: "2024-01-02T12:00:00Z", weekdayName: "tuesday", cronNumber: 2 },
            { date: "2024-01-03T12:00:00Z", weekdayName: "wednesday", cronNumber: 3 },
            { date: "2024-01-04T12:00:00Z", weekdayName: "thursday", cronNumber: 4 },
            { date: "2024-01-05T12:00:00Z", weekdayName: "friday", cronNumber: 5 },
            { date: "2024-01-06T12:00:00Z", weekdayName: "saturday", cronNumber: 6 },
            { date: "2024-01-07T12:00:00Z", weekdayName: "sunday", cronNumber: 0 },
        ];

        testCases.forEach(({ date, weekdayName, cronNumber }) => {
            const luxonDateTime = LuxonDateTime.fromISO(date);
            const dateTime = DateTime.fromLuxon(luxonDateTime);
            
            // Verify DateTime returns weekday name
            expect(dateTime.weekday).toBe(weekdayName);
            
            // Should match the correct weekday cron expression (using number)
            const correctCronExpr = parseCronExpression(`* * * * ${cronNumber}`);
            expect(matchesCronExpression(correctCronExpr, dateTime)).toBe(true);
            
            // Should not match a different weekday
            const differentCronNumber = cronNumber === 0 ? 1 : 0;
            const incorrectCronExpr = parseCronExpression(`* * * * ${differentCronNumber}`);
            expect(matchesCronExpression(incorrectCronExpr, dateTime)).toBe(false);
        });
    });

    test("parseCronExpression should handle numeric weekday ranges", () => {
        // Monday to Friday (1-5)
        const mondayToFridayCron = parseCronExpression("* * * * 1-5");
        expect(mondayToFridayCron.weekday).toEqual([1, 2, 3, 4, 5]);
        
        // Sunday to Tuesday (0-2)
        const sundayToTuesdayCron = parseCronExpression("* * * * 0-2");
        expect(sundayToTuesdayCron.weekday).toEqual([0, 1, 2]);
    });

    test("parseCronExpression should handle comma-separated numeric weekday values", () => {
        // Mixed numbers
        const mixedCron = parseCronExpression("* * * * 1,3,5");
        expect(mixedCron.weekday).toEqual([1, 3, 5]);
        
        // Single value
        const singleCron = parseCronExpression("* * * * 0");
        expect(singleCron.weekday).toEqual([0]);
    });
});