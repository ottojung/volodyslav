
/**
 * @typedef {import("../expression").CronExpression} CronExpression
 */

/**
 * Generator that yields valid (year, month, day) tuples starting from the given date.
 * @param {CronExpression} cronExpr
 * @param {import("../../datetime").DateTime} startDate
 * @returns {Generator<{year: number, month: number, day: number}>} Tuples
 */
function* iterateValidDays(cronExpr, startDate) {
    const origin = startDate;

    const oyear = origin.year;
    const omonth = origin.month;
    let year = origin.year;
    let month = origin.month;

    // Limit to 10 years forward to prevent infinite loops.
    // It must be impossible to have a valid cron expression that doesn't for that long.
    while (year < oyear + 10) {
        let validDays = cronExpr.validDays(year, month);
        if (month === omonth && year === oyear) {
            validDays = validDays.filter(d => d >= origin.day);
        }

        for (const day of validDays) {
            yield { year, month, day };
        }

        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
}


/**
 * Generator that yields valid (year, month, day) tuples starting from the given date.
 * @param {CronExpression} cronExpr
 * @param {import("../../datetime").DateTime} startDate
 * @returns {Generator<{year: number, month: number, day: number}>} Tuples
 */
function* iterateValidDaysBackwards(cronExpr, startDate) {
    const origin = startDate;

    const oyear = origin.year;
    const omonth = origin.month;
    let year = origin.year;
    let month = origin.month;

    // Limit to 10 years back to prevent infinite loops.
    // It must be impossible to have a valid cron expression that doesn't for that long.
    while (year > oyear - 10) {
        let validDays = cronExpr.validDays(year, month);
        if (month === omonth && year === oyear) {
            validDays = validDays.filter(d => d <= origin.day);
        }

        for (const day of [...validDays].reverse()) {
            yield { year, month, day };
        }

        month -= 1;
        if (month < 1) {
            month = 12;
            year -= 1;
        }
    }
}

module.exports = {
    iterateValidDays,
    iterateValidDaysBackwards,
};
