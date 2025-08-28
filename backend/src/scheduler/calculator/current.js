/**
 * Cron expression matching.
 */

const datetime = require("../../datetime");

/**
 * Checks if a given datetime matches the cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} dateTime - DateTime to check
 * @returns {boolean} True if the datetime matches the cron expression
 */
function matchesCronExpression(cronExpr, dateTime) {
    const dt = datetime.make();
    const nativeDate = dt.toNativeDate(dateTime);

    const minute = nativeDate.getMinutes();
    const hour = nativeDate.getHours();
    const day = nativeDate.getDate();
    const month = nativeDate.getMonth() + 1; // JS months are 0-based, cron months are 1-based
    const weekday = nativeDate.getDay(); // Both JS and cron use 0=Sunday

    return (
        cronExpr.minute.includes(minute) &&
        cronExpr.hour.includes(hour) &&
        cronExpr.day.includes(day) &&
        cronExpr.month.includes(month) &&
        cronExpr.weekday.includes(weekday)
    );
}

module.exports = {
    matchesCronExpression,
};
