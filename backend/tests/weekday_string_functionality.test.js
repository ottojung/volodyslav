/**
 * Test for weekday string functionality
 */

const { DateTime: LuxonDateTime } = require("luxon");
const { parseCronExpression, matchesCronExpression } = require("../src/scheduler");
const { DateTime } = require("../src/datetime");
const { getAllWeekdayNames, isWeekdayName, luxonWeekdayToName } = require("../src/weekday");

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
            const dateTime = new DateTime(luxonDateTime);
            expect(dateTime.weekday).toBe(expected);
        });
    });

    test("parseCronExpression should accept weekday names", () => {
        const weekdayNames = getAllWeekdayNames();
        
        weekdayNames.forEach(weekdayName => {
            const cronExpr = parseCronExpression(`* * * * ${weekdayName}`);
            expect(cronExpr.weekday).toEqual([weekdayName]);
        });
    });

    test("parseCronExpression should still accept numeric weekday values for backward compatibility", () => {
        const testCases = [
            { numeric: "0", expected: ["sunday"] },
            { numeric: "1", expected: ["monday"] },
            { numeric: "2", expected: ["tuesday"] },
            { numeric: "3", expected: ["wednesday"] },
            { numeric: "4", expected: ["thursday"] },
            { numeric: "5", expected: ["friday"] },
            { numeric: "6", expected: ["saturday"] },
        ];

        testCases.forEach(({ numeric, expected }) => {
            const cronExpr = parseCronExpression(`* * * * ${numeric}`);
            expect(cronExpr.weekday).toEqual(expected);
        });
    });

    test("matchesCronExpression should work with weekday names", () => {
        // Test each day of the week
        const testCases = [
            { date: "2024-01-01T12:00:00Z", weekdayName: "monday" },
            { date: "2024-01-02T12:00:00Z", weekdayName: "tuesday" },
            { date: "2024-01-03T12:00:00Z", weekdayName: "wednesday" },
            { date: "2024-01-04T12:00:00Z", weekdayName: "thursday" },
            { date: "2024-01-05T12:00:00Z", weekdayName: "friday" },
            { date: "2024-01-06T12:00:00Z", weekdayName: "saturday" },
            { date: "2024-01-07T12:00:00Z", weekdayName: "sunday" },
        ];

        testCases.forEach(({ date, weekdayName }) => {
            const luxonDateTime = LuxonDateTime.fromISO(date);
            const dateTime = new DateTime(luxonDateTime);
            
            // Should match the correct weekday
            const correctCronExpr = parseCronExpression(`* * * * ${weekdayName}`);
            expect(matchesCronExpression(correctCronExpr, dateTime)).toBe(true);
            
            // Should not match a different weekday
            const otherWeekdayNames = getAllWeekdayNames().filter(name => name !== weekdayName);
            const randomOtherWeekday = otherWeekdayNames[0];
            const incorrectCronExpr = parseCronExpression(`* * * * ${randomOtherWeekday}`);
            expect(matchesCronExpression(incorrectCronExpr, dateTime)).toBe(false);
        });
    });

    test("parseCronExpression should handle weekday ranges", () => {
        // Monday to Friday (1-5)
        const mondayToFridayCron = parseCronExpression("* * * * 1-5");
        expect(mondayToFridayCron.weekday).toEqual(["monday", "tuesday", "wednesday", "thursday", "friday"]);
        
        // Sunday to Tuesday (0-2)
        const sundayToTuesdayCron = parseCronExpression("* * * * 0-2");
        expect(sundayToTuesdayCron.weekday).toEqual(["sunday", "monday", "tuesday"]);
    });

    test("parseCronExpression should handle comma-separated weekday values", () => {
        // Mix of names and numbers
        const mixedCron = parseCronExpression("* * * * monday,3,friday");
        expect(mixedCron.weekday).toEqual(["monday", "wednesday", "friday"]);
        
        // All weekday names
        const allNamesCron = parseCronExpression("* * * * sunday,monday,tuesday,wednesday,thursday,friday,saturday");
        expect(allNamesCron.weekday).toEqual(getAllWeekdayNames());
    });

    test("parseCronExpression should handle wildcard for weekdays", () => {
        const wildcardCron = parseCronExpression("* * * * *");
        expect(wildcardCron.weekday).toEqual(getAllWeekdayNames());
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
        expect(allNames).toHaveLength(7);
        expect(allNames[0]).toBe("sunday");
        expect(allNames[6]).toBe("saturday");
    });
});