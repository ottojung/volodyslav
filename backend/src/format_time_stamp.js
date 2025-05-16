/**
 * @param {string} filename
 * @returns {Date}
 */
function formatFileTimestamp(filename) {
    // 1) extract the basic‐ISO timestamp (YYYYMMDDThhmmssZ)
    const m = filename.match(/^(\d{8}T\d{6}Z)[.].*/);
    if (!m) throw new Error("Filename does not start with YYYYMMDDThhmmssZ");

    const basic = m[1];

    // 2) convert to a true ISO string: "YYYY-MM-DDThh:mm:ssZ"
    const isoUTC = format_time_stamp(basic);

    if (typeof isoUTC !== 'string' || isoUTC === basic) { // Check if replace did anything or if it's a valid string
        // basic.replace might return the original string if no match is found.
        // Or handle if isoUTC is not a string as expected.
        return "Invalid date format"; // Or return undefined or throw an error
    }

    // 3) parse into a Date
    const d = new Date(isoUTC);

    return d;
}

/**
 * @param {string | undefined} basic
 * @returns {Date | undefined}
 */
function format_time_stamp(basic) {
    if (basic === undefined) {
        return undefined;
    }
    const isoUTC = basic.replace(
        /(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})/,
        "$1-$2-$3T$4:$5:$6Z"
    );

    if (isoUTC === basic) { 
        return undefined;
    }

    const d = new Date(isoUTC);
    if (isNaN(d.getTime())) {
        return undefined;
    }
    return d;
}

module.exports = {
    formatFileTimestamp,
};
