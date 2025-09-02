/**
 * Test to demonstrate and verify the fix for the timezone weekday bug.
 * Issue: matchesCronExpression calculates weekday based on UTC epoch, ignoring DateTime timezone.
 */

const { DateTime: LuxonDateTime } = require("luxon");
const { parseCronExpression, matchesCronExpression } = require("../src/scheduler");
const { DateTime, fromEpochMs } = require("../src/datetime");

describe("Timezone weekday bug", () => {
    test("should handle timezone-aware weekday calculation", () => {
        // 2024-01-01T00:00 in UTC+02 timezone
        // This should be Monday (weekday 1 in cron format), not Sunday (weekday 0)
        const luxonDateTime = LuxonDateTime.fromISO("2024-01-01T00:00:00", { zone: "UTC+2" });
        const dateTimeUTCPlus2 = new DateTime(luxonDateTime);
        
        // Verify this is actually Monday in the local timezone
        expect(luxonDateTime.weekday).toBe(1); // Luxon: 1=Monday
        
        // Create Monday cron expression (1 = Monday in cron format)
        const mondayExpr = parseCronExpression("* * * * 1");
        
        // This should match because 2024-01-01 00:00 UTC+2 is a Monday
        // But current implementation incorrectly calculates weekday based on UTC
        expect(matchesCronExpression(mondayExpr, dateTimeUTCPlus2)).toBe(true);
    });

    test("should handle UTC midnight vs timezone midnight", () => {
        // 2024-01-01T00:00:00Z (UTC) - this is Monday
        const utcMidnight = fromEpochMs(1704067200000); // 2024-01-01T00:00:00.000Z
        
        // 2024-01-01T00:00:00 in UTC-05 timezone - this is also Monday locally 
        const easternMidnight = new DateTime(LuxonDateTime.fromISO("2024-01-01T00:00:00", { zone: "UTC-5" }));
        
        const mondayExpr = parseCronExpression("* * * * 1"); // Monday
        
        // Both should match Monday expression
        expect(matchesCronExpression(mondayExpr, utcMidnight)).toBe(true);
        expect(matchesCronExpression(mondayExpr, easternMidnight)).toBe(true);
    });

    test("should handle boundary case around timezone offset", () => {
        // 2024-01-01T02:00:00Z - this is Monday in UTC  
        const utcDateTime = fromEpochMs(1704074400000); // 2024-01-01T02:00:00.000Z
        
        // Same UTC time but in UTC+02 timezone - still Monday locally
        const localDateTime = new DateTime(LuxonDateTime.fromMillis(1704074400000, { zone: "UTC+2" }));
        
        const mondayExpr = parseCronExpression("* * * * 1"); // Monday
        
        // Both should match Monday
        expect(matchesCronExpression(mondayExpr, utcDateTime)).toBe(true);
        expect(matchesCronExpression(mondayExpr, localDateTime)).toBe(true);
    });

    test("should correctly convert Luxon weekday to cron weekday format", () => {
        // Test each day of the week
        const testCases = [
            { date: "2024-01-01T00:00:00Z", luxonWeekday: 1, cronWeekday: 1, day: "Monday" },    // Mon
            { date: "2024-01-02T00:00:00Z", luxonWeekday: 2, cronWeekday: 2, day: "Tuesday" },   // Tue
            { date: "2024-01-03T00:00:00Z", luxonWeekday: 3, cronWeekday: 3, day: "Wednesday" }, // Wed
            { date: "2024-01-04T00:00:00Z", luxonWeekday: 4, cronWeekday: 4, day: "Thursday" },  // Thu
            { date: "2024-01-05T00:00:00Z", luxonWeekday: 5, cronWeekday: 5, day: "Friday" },    // Fri
            { date: "2024-01-06T00:00:00Z", luxonWeekday: 6, cronWeekday: 6, day: "Saturday" },  // Sat
            { date: "2024-01-07T00:00:00Z", luxonWeekday: 7, cronWeekday: 0, day: "Sunday" },    // Sun
        ];

        testCases.forEach(({ date, luxonWeekday, cronWeekday, day: _day }) => {
            const luxonDateTime = LuxonDateTime.fromISO(date);
            const dateTime = new DateTime(luxonDateTime);
            
            // Verify Luxon weekday is as expected
            expect(dateTime._luxonDateTime.weekday).toBe(luxonWeekday);
            
            // Verify the conversion formula
            const convertedWeekday = luxonWeekday % 7;
            expect(convertedWeekday).toBe(cronWeekday);
            
            // Verify it matches the expected cron expression
            const cronExpr = parseCronExpression(`* * * * ${cronWeekday}`);
            expect(matchesCronExpression(cronExpr, dateTime)).toBe(true);
        });
    });
});