/**
 * Test to demonstrate and verify the fix for the timezone weekday bug.
 * Issue: matchesCronExpression calculates weekday based on UTC epoch, ignoring DateTime timezone.
 */

const { DateTime: LuxonDateTime } = require("luxon");
const { parseCronExpression, matchesCronExpression } = require("../src/scheduler");
const { fromEpochMs } = require("../src/datetime");
const DateTime = require('../src/datetime/structure');

describe("Timezone weekday bug", () => {
    test("should handle timezone-aware weekday calculation", () => {
        // 2024-01-01T00:00 in UTC+02 timezone
        // This should be Monday (weekday "monday"), not Sunday ("sunday")
        const luxonDateTime = LuxonDateTime.fromISO("2024-01-01T00:00:00", { zone: "UTC+2" });
        const dateTimeUTCPlus2 = DateTime.fromLuxon(luxonDateTime);
        
        // Verify this is actually Monday in the local timezone
        expect(luxonDateTime.weekday).toBe(1); // Luxon: 1=Monday
        expect(dateTimeUTCPlus2.weekday).toBe("monday"); // Our DateTime: "monday"
        
        // Create Monday cron expression (uses numeric 1 for Monday)
        const mondayExpr = parseCronExpression("* * * * 1");
        
        // This should match because 2024-01-01 00:00 UTC+2 is a Monday
        expect(matchesCronExpression(mondayExpr, dateTimeUTCPlus2)).toBe(true);
    });

    test("should handle UTC midnight vs timezone midnight", () => {
        // 2024-01-01T00:00:00Z (UTC) - this is Monday
        const utcMidnight = fromEpochMs(1704067200000); // 2024-01-01T00:00:00.000Z
        
        // 2024-01-01T00:00:00 in UTC-05 timezone - this is also Monday locally 
        const easternMidnight = DateTime.fromLuxon(LuxonDateTime.fromISO("2024-01-01T00:00:00", { zone: "UTC-5" }));
        
        const mondayExpr = parseCronExpression("* * * * 1"); // Monday
        
        // Both should match Monday expression
        expect(matchesCronExpression(mondayExpr, utcMidnight)).toBe(true);
        expect(matchesCronExpression(mondayExpr, easternMidnight)).toBe(true);
    });

    test("should handle boundary case around timezone offset", () => {
        // 2024-01-01T02:00:00Z - this is Monday in UTC  
        const utcDateTime = fromEpochMs(1704074400000); // 2024-01-01T02:00:00.000Z
        
        // Same UTC time but in UTC+02 timezone - still Monday locally
        const localDateTime = DateTime.fromLuxon(LuxonDateTime.fromMillis(1704074400000, { zone: "UTC+2" }));
        
        const mondayExpr = parseCronExpression("* * * * 1"); // Monday
        
        // Both should match Monday
        expect(matchesCronExpression(mondayExpr, utcDateTime)).toBe(true);
        expect(matchesCronExpression(mondayExpr, localDateTime)).toBe(true);
    });

    test("should correctly return weekday names from DateTime", () => {
        // Test each day of the week
        const testCases = [
            { date: "2024-01-01T00:00:00Z", luxonWeekday: 1, weekdayName: "monday", cronNumber: 1, day: "Monday" },    // Mon
            { date: "2024-01-02T00:00:00Z", luxonWeekday: 2, weekdayName: "tuesday", cronNumber: 2, day: "Tuesday" },   // Tue
            { date: "2024-01-03T00:00:00Z", luxonWeekday: 3, weekdayName: "wednesday", cronNumber: 3, day: "Wednesday" }, // Wed
            { date: "2024-01-04T00:00:00Z", luxonWeekday: 4, weekdayName: "thursday", cronNumber: 4, day: "Thursday" },  // Thu
            { date: "2024-01-05T00:00:00Z", luxonWeekday: 5, weekdayName: "friday", cronNumber: 5, day: "Friday" },    // Fri
            { date: "2024-01-06T00:00:00Z", luxonWeekday: 6, weekdayName: "saturday", cronNumber: 6, day: "Saturday" },  // Sat
            { date: "2024-01-07T00:00:00Z", luxonWeekday: 7, weekdayName: "sunday", cronNumber: 0, day: "Sunday" },    // Sun
        ];

        testCases.forEach(({ date, luxonWeekday, weekdayName, cronNumber, day: _day }) => {
            const luxonDateTime = LuxonDateTime.fromISO(date);
            const dateTime = DateTime.fromLuxon(luxonDateTime);
            
            // Verify Luxon weekday is as expected (via public interface)
            expect(luxonDateTime.weekday).toBe(luxonWeekday);
            
            // Verify our DateTime returns the correct weekday name
            expect(dateTime.weekday).toBe(weekdayName);
            
            // Verify it matches the expected cron expression (now using numeric value)
            const cronExpr = parseCronExpression(`* * * * ${cronNumber}`);
            expect(matchesCronExpression(cronExpr, dateTime)).toBe(true);
        });
    });
});