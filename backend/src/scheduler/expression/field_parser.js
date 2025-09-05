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
 * @returns {boolean[]} A mask of valid values for this field
 * @throws {FieldParseError} If the field value is invalid
 */
function parseField(value, config) {
    const result = Array.from({ length: config.max - config.min + 1 }, () => false);
    if (value === "*") {
        for (let i = 0; i < result.length; i++) {
            result[i] = true;
        }
        return result;
    }

    if (value.includes(",")) {
        const parts = value.split(",");
        const result = [];
        for (const part of parts) {
            const field = parseField(part.trim(), config);
            field.forEach((isValid, index) => {
                if (isValid) {
                    result[index] = true;
                }
            });
        }
    }

    if (value.includes("/")) {
        const parts = value.split("/");
        if (parts.length !== 2) {
            throw new FieldParseError(`invalid step format "${value}"`, value, config.name);
        }
        const range = parts[0];
        const stepStr = parts[1];
        if (!range || !stepStr) {
            throw new FieldParseError(`invalid step format "${value}"`, value, config.name);
        }
        const stepNum = parseInt(stepStr, 10);
        if (isNaN(stepNum) || stepNum <= 0) {
            throw new FieldParseError(`invalid step value "${stepStr}"`, value, config.name);
        }

        const baseValues = parseField(range, config);
        for (let i = 0; i < baseValues.length; i += stepNum) {
            const val = baseValues[i];
            if (val) {
                result[i] = true;
            }
        }
        return result;
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

        for (let i = startNum; i <= endNum; i++) {
            result[i - config.min] = true;
        }
        return result;
    }       

    const num = parseInt(value, 10);
    if (isNaN(num)) {
        throw new FieldParseError(`invalid number "${value}"`, value, config.name);
    }

    if (num < config.min || num > config.max) {
        throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
    }

    result[num] = true;
    return result;
}

module.exports = {
    FIELD_CONFIGS,
    parseField,
    isFieldParseError,
};
