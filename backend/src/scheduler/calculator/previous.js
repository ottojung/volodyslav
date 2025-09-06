/**
 * Previous fire time calculation API.
 */

const { matchesCronExpression } = require("./current");
const { dateTimeFromObject } = require("../../datetime");
const { iterateValidDaysBackwards } = require("../expression/structure");

/**
 * Calculates the previous execution time for a cron expression.
 * Note: it is inclusive. I.e. if `fromDateTime` matches the cron expression,
 * it will be returned as the previous execution time.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} origin - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Previous execution datetime, or null if none found
 */
function getMostRecentExecution(cronExpr, origin) {
    for (const { year, month, day } of iterateValidDaysBackwards(cronExpr, origin)) {
        const getTime = () => {
            const validHours = cronExpr.validHours;
            const validMinutes = cronExpr.validMinutes;
            if (day === origin.day && year === origin.year && month === origin.month) {
                const filteredHours = validHours.filter(h => h <= origin.hour);
                const hour = filteredHours[filteredHours.length - 1];
                if (hour === undefined) {
                    return null;
                }

                const filteredMinutes = validMinutes.filter(m => m <= origin.minute);
                const minute = hour === origin.hour
                    ? filteredMinutes[filteredMinutes.length - 1]
                    : validMinutes[validMinutes.length - 1];
                if (minute === undefined) {
                    const filteredHours = validHours.filter(h => h < origin.hour);
                    const hour = filteredHours[filteredHours.length - 1];
                    if (hour === undefined) {
                        return null;
                    }
                    const minute = validMinutes[validMinutes.length - 1];
                    if (minute === undefined) {
                        throw new Error("Internal error: no valid minutes in cron expression");
                    }
                    return { hour, minute };
                }

                return { hour, minute };
            } else {
                const hour = validHours[validHours.length - 1];
                const minute = validMinutes[validMinutes.length - 1];
                return { hour, minute };
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
        }, {
            zone: origin.zone ? origin.zone : undefined,
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
    getMostRecentExecution,
};
