/**
 * Next execution calculation API.
 */

const { dateTimeFromObject } = require('../../datetime');
const { matchesCronExpression } = require('./current');

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} origin - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, origin) {
    let year = origin.year;
    let month = origin.month;

    let dayCount = 0;

    // eslint-disable-next-line no-constant-condition    
    while (true) {
        let validDays = cronExpr.validDays(year, month);
        if (dayCount === 0) {
            validDays = validDays.filter(d => d >= origin.day);
        }

        for (const day of validDays) {
            let hour = cronExpr.validHours[0];
            let minute = cronExpr.validMinutes[0];
            if (dayCount === 0) {
                dayCount++;
                hour = cronExpr.validHours.filter(h => h >= origin.hour)[0];
                minute = cronExpr.validMinutes.filter(m => m > origin.minute)[0];
                if (hour === undefined || minute === undefined) {
                    continue;
                }
            }

            const candidate = dateTimeFromObject({
                year,
                month,
                day,
                hour,
                minute,
                second: 0,
                millisecond: 0,
            });
            if (candidate.isValid === false) {
                continue;
            }
            if (matchesCronExpression(cronExpr, candidate)) {
                return candidate;
            }
        }

        // Advance to next month.
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
}

module.exports = {
    getNextExecution,
};
