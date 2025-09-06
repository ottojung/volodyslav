/**
 * Next execution calculation API.
 */

const { dateTimeFromObject } = require('../../datetime');
const { iterateValidDays } = require('../expression');
const { matchesCronExpression } = require('./current');

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} origin - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, origin) {
    for (const { year, month, day } of iterateValidDays(cronExpr, origin)) {
        const getTime = () => {
            if (day === origin.day && year === origin.year && month === origin.month) {
                const hour = cronExpr.validHours.filter(h => h >= origin.hour)[0];
                if (hour === undefined) {
                    return null;
                }

                const minute = hour === origin.hour
                    ? cronExpr.validMinutes.filter(m => m > origin.minute)[0]
                    : cronExpr.validMinutes[0];
                if (minute === undefined) {
                    const hour = cronExpr.validHours.filter(h => h > origin.hour)[0];
                    if (hour === undefined) {
                        return null;
                    }
                    const minute = cronExpr.validMinutes[0];
                    if (minute === undefined) {
                        return null;
                    }
                    return { hour, minute };
                }

                return { hour, minute };
            } else {
                return { hour: cronExpr.validHours[0], minute: cronExpr.validMinutes[0] };
            }
        };

        const time = getTime();
        if (time === null) {
            continue;
        }

        const { hour, minute } = time;

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
            throw new Error(`Invalid candidate datetime: ${candidate}`);
        }
        if (matchesCronExpression(cronExpr, candidate)) {
            return candidate;
        } else {
            throw new Error("Internal error: candidate does not match cron expression");
        }
    }

    throw new Error("No valid next execution time found");
}

module.exports = {
    getNextExecution,
};
