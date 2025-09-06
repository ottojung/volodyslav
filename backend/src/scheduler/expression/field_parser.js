/**
 * Field configuration and parsing for cron expressions.
 */

/**
 * Custom error class for field parsing errors.
 */
class FieldParseError extends Error {
    /**
     * @param {string} message
     * @param {string} fieldValue
     * @param {string} fieldName
     */
    constructor(message, fieldValue, fieldName) {
        super(message);
        this.name = "FieldParseError";
        this.fieldValue = fieldValue;
        this.fieldName = fieldName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is FieldParseError}
 */
function isFieldParseError(object) {
    return object instanceof FieldParseError;
}

/**
 * @typedef {object} FieldConfig
 * @property {number} min - Minimum allowed value
 * @property {number} max - Maximum allowed value  
 * @property {string} name - Field name for error messages
 */

/**
 * Field configuration for cron expression validation.
 */
const FIELD_CONFIGS = {
    minute: { min: 0, max: 59, name: "minute" },
    hour: { min: 0, max: 23, name: "hour" },
    day: { min: 1, max: 31, name: "day" },
    month: { min: 1, max: 12, name: "month" },
    weekday: { min: 0, max: 6, name: "weekday" } // 0 = Sunday, 6 = Saturday
};

/**
 * Parses a single cron field value.
 * @param {string} value - The field value to parse
 * @param {FieldConfig} config - Field configuration
 * @returns {boolean[]} Boolean mask where index indicates if value is valid
 * @throws {FieldParseError} If the field value is invalid
 */
function parseField(value, config) {
    // Create boolean mask with correct length for the field
    const maskLength = config.max + 1; // +1 to include the max value
    
    if (value === "*") {
        const mask = new Array(maskLength).fill(false);
        // Set all valid values to true
        for (let i = config.min; i <= config.max; i++) {
            mask[i] = true;
        }
        return mask;
    }

    if (value.includes(",")) {
        const parts = value.split(",");
        const mask = new Array(maskLength).fill(false);
        
        for (const part of parts) {
            const partMask = parseField(part.trim(), config);
            // Merge the part mask into the main mask
            for (let i = 0; i < partMask.length; i++) {
                if (partMask[i]) {
                    mask[i] = true;
                }
            }
        }
        return mask;
    }

    if (value.includes("/")) {
        throw new FieldParseError(`slash syntax not supported "${value}"`, value, config.name);
    }

    if (value.includes("-")) {
        const parts = value.split("-");
        if (parts.length !== 2) {
            throw new FieldParseError(`invalid range format "${value}"`, value, config.name);
        }
        const startStr = parts[0];
        const endStr = parts[1];
        if (!startStr || !endStr) {
            throw new FieldParseError(`invalid range format "${value}"`, value, config.name);
        }
        const startNum = parseInt(startStr, 10);
        const endNum = parseInt(endStr, 10);

        if (isNaN(startNum) || isNaN(endNum)) {
            throw new FieldParseError(`invalid range "${value}"`, value, config.name);
        }

        if (startNum < config.min || startNum > config.max) {
            throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
        }

        if (endNum < config.min || endNum > config.max) {
            throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
        }

        if (startNum > endNum) {
            throw new FieldParseError(`invalid range (start > end)`, value, config.name);
        }

        const mask = new Array(maskLength).fill(false);
        for (let i = startNum; i <= endNum; i++) {
            mask[i] = true;
        }
        return mask;
    }

    const num = parseInt(value, 10);
    if (isNaN(num)) {
        throw new FieldParseError(`invalid number "${value}"`, value, config.name);
    }

    if (num < config.min || num > config.max) {
        throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
    }

    const mask = new Array(maskLength).fill(false);
    mask[num] = true;
    return mask;
}

module.exports = {
    FIELD_CONFIGS,
    parseField,
    isFieldParseError,
};
