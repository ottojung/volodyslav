/**
 * Test to demonstrate the timezone inconsistency bug between matchesCronExpression and getNextExecution.
 * Issue: matchesCronExpression respects timezone, but getNextExecution loses timezone during iteration.
 */

const { DateTime: LuxonDateTime } = require("luxon");
const { parseCronExpression, matchesCronExpression, getNextExecution } = require("../src/scheduler");
const DateTime = require('../src/datetime/structure');

describe("Timezone inconsistency bug", () => {
    test("getNextExecution should preserve timezone from input DateTime", () => {
        // Create a DateTime in UTC+2 timezone
        const utcPlus2DateTime = DateTime.fromLuxon(
            LuxonDateTime.fromISO("2024-01-01T10:00:00", { zone: "UTC+2" })
        );
        
        // Create a cron expression that should trigger every minute
        const everyMinuteExpr = parseCronExpression("* * * * *");
        
        // Get the next execution time
        const nextExecution = getNextExecution(everyMinuteExpr, utcPlus2DateTime);
        
        // The next execution should preserve the UTC+2 timezone
        // Both the input and output should have the same timezone
        expect(nextExecution._luxonDateTime.zone.name).toBe(utcPlus2DateTime._luxonDateTime.zone.name);
        expect(nextExecution._luxonDateTime.zoneName).toBe("UTC+2");
    });

    test("getNextExecution should work consistently with matchesCronExpression for timezone-specific weekdays", () => {
        // Create a DateTime for Sunday 23:30 in UTC+2 (which is Monday 01:30 in UTC)
        // In UTC+2 timezone, this is Sunday, but in UTC it would be Monday
        const sundayEvening = DateTime.fromLuxon(
            LuxonDateTime.fromISO("2024-01-07T23:30:00", { zone: "UTC+2" })
        );
        
        // Verify this is Sunday in the local timezone
        expect(sundayEvening.weekday).toBe("sunday");
        
        // Create a cron expression for Monday at 00:00 (should trigger in 30 minutes)
        const mondayMidnightExpr = parseCronExpression("0 0 * * 1"); // Monday at midnight
        
        // Get the next execution time
        const nextExecution = getNextExecution(mondayMidnightExpr, sundayEvening);
        
        // The next execution should be Monday at 00:00 in UTC+2
        expect(nextExecution.weekday).toBe("monday");
        expect(nextExecution.hour).toBe(0);
        expect(nextExecution.minute).toBe(0);
        expect(nextExecution._luxonDateTime.zoneName).toBe("UTC+2");
        
        // Most importantly, matchesCronExpression should agree with this result
        expect(matchesCronExpression(mondayMidnightExpr, nextExecution)).toBe(true);
    });

    test("getNextExecution should handle timezone boundaries correctly", () => {
        // Create a DateTime for 2024-01-01T23:30 in UTC+5 (which is 2024-01-02T04:30 in UTC)
        // In UTC+5, this is Monday, but the next day boundary is different in UTC
        const mondayEvening = DateTime.fromLuxon(
            LuxonDateTime.fromISO("2024-01-01T23:30:00", { zone: "UTC+5" })
        );
        
        // Create a cron expression for Tuesday at 00:00 
        const tuesdayMidnightExpr = parseCronExpression("0 0 * * 2"); // Tuesday at midnight
        
        // Get the next execution time
        const nextExecution = getNextExecution(tuesdayMidnightExpr, mondayEvening);
        
        // The next execution should be Tuesday at 00:00 in UTC+5
        expect(nextExecution.weekday).toBe("tuesday");
        expect(nextExecution.hour).toBe(0);
        expect(nextExecution.minute).toBe(0);
        expect(nextExecution._luxonDateTime.zoneName).toBe("UTC+5");
        
        // matchesCronExpression should agree
        expect(matchesCronExpression(tuesdayMidnightExpr, nextExecution)).toBe(true);
    });
});