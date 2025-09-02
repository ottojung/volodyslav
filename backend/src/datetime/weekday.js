/**
 * Weekday string utilities.
 */

/**
 * @typedef {"sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday"} WeekdayName
 */

/**
 * Convert Luxon weekday number to weekday name string.
 * Luxon weekday: 1=Monday, 2=Tuesday, ..., 7=Sunday
 * @param {number} luxonWeekday - Luxon weekday number (1-7)
 * @returns {WeekdayName} Weekday name string
 */
function luxonWeekdayToName(luxonWeekday) {
    switch (luxonWeekday) {
        case 1: return "monday";
        case 2: return "tuesday";
        case 3: return "wednesday";
        case 4: return "thursday";
        case 5: return "friday";
        case 6: return "saturday";
        case 7: return "sunday";
        default:
            throw new Error(`Invalid Luxon weekday: ${luxonWeekday}`);
    }
}

/**
 * Convert weekday name string to cron weekday number for backward compatibility.
 * Cron weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
 * @param {WeekdayName} weekdayName - Weekday name string
 * @returns {number} Cron weekday number (0-6)
 */
function weekdayNameToCronNumber(weekdayName) {
    switch (weekdayName) {
        case "sunday": return 0;
        case "monday": return 1;
        case "tuesday": return 2;
        case "wednesday": return 3;
        case "thursday": return 4;
        case "friday": return 5;
        case "saturday": return 6;
        default:
            throw new Error(`Invalid weekday name: ${weekdayName}`);
    }
}

/**
 * Convert cron weekday number to weekday name string.
 * Cron weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
 * @param {number} cronWeekday - Cron weekday number (0-6)
 * @returns {WeekdayName} Weekday name string
 */
function cronNumberToWeekdayName(cronWeekday) {
    switch (cronWeekday) {
        case 0: return "sunday";
        case 1: return "monday";
        case 2: return "tuesday";
        case 3: return "wednesday";
        case 4: return "thursday";
        case 5: return "friday";
        case 6: return "saturday";
        default:
            throw new Error(`Invalid cron weekday: ${cronWeekday}`);
    }
}

/**
 * Check if a string is a valid weekday name.
 * @param {string} value - String to check
 * @returns {value is WeekdayName} True if valid weekday name
 */
function isWeekdayName(value) {
    return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].includes(value);
}

/**
 * Get all weekday names.
 * @returns {WeekdayName[]} Array of all weekday names
 */
function getAllWeekdayNames() {
    return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
}

module.exports = {
    luxonWeekdayToName,
    weekdayNameToCronNumber,
    cronNumberToWeekdayName,
    isWeekdayName,
    getAllWeekdayNames,
};
