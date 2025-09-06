
/**
 * Get the maximum number of days in a month.
 * @param {number} year - The year (e.g., 2023)
 * @param {number} month - The month (1-12)
 * @returns {number} The maximum number of days in the month
 */
function getMaxDaysInMonth(year, month) {
    // Month is 1-based (1=January, 12=December)
    if (month === 2) {
        // February - check for leap year
        if ((year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0)) {
            return 29; // Leap year
        } else {
            return 28; // Non-leap year
        }
    } else if ([4, 6, 9, 11].includes(month)) {
        return 30; // April, June, September, November
    } else {
        return 31; // January, March, May, July, August, October, December
    }
}

module.exports = {
    getMaxDaysInMonth,
};
