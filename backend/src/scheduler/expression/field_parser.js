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
 * Enforces POSIX-compliant ranges as defined in IEEE Std 1003.1.
 */
const FIELD_CONFIGS = {
    minute: { min: 0, max: 59, name: "minute" },
    hour: { min: 0, max: 23, name: "hour" },
    day: { min: 1, max: 31, name: "day" },
    month: { min: 1, max: 12, name: "month" },
    // POSIX weekday range: 0-6 (0 = Sunday, 6 = Saturday)
    // Explicitly rejects 7 for Sunday as this is a non-POSIX extension
    weekday: { min: 0, max: 6, name: "weekday" }
};

/**
 * Validates that a field value is POSIX compliant.
 * Rejects non-POSIX extensions like names, macros, and Quartz tokens.
 * @param {string} value - The field value to validate
 * @param {FieldConfig} config - Field configuration
 * @throws {FieldParseError} If the field value contains non-POSIX extensions
 */
function validatePosixCompliance(value, config) {
    // Reject macro syntax (@hourly, @reboot, etc.)
    if (value.startsWith("@")) {
        throw new FieldParseError(`macro syntax not supported (POSIX violation) "${value}"`, value, config.name);
    }
    
    // Reject Quartz tokens (?, L, W, #)
    const quartz_tokens = ["?", "L", "W", "#"];
    for (const token of quartz_tokens) {
        if (value.includes(token)) {
            throw new FieldParseError(`Quartz token '${token}' not supported (POSIX violation) "${value}"`, value, config.name);
        }
    }
    
    // Reject names (mon, jan, etc.) - detect alphabetic characters
    // Allow digits, decimal points, scientific notation, wildcards (*), ranges (-), commas (,), and whitespace
    // This allows parseInt to handle decimal/scientific notation naturally while rejecting named tokens
    const allowedPattern = /^[\d\s,*.\-eE+]+$/;
    if (!allowedPattern.test(value)) {
        throw new FieldParseError(`names not supported, use numbers only (POSIX violation) "${value}"`, value, config.name);
    }
}

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
        throw new FieldParseError(`slash syntax not supported (POSIX violation) "${value}"`, value, config.name);
    }

    // POSIX compliance validation - reject non-POSIX extensions after checking for slashes
    validatePosixCompliance(value, config);

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
        
        // Verify the parsed numbers match the original strings to catch cases like "1e" -> 1 or "1e10" -> 1e10
        // Allow leading zeros by using specific pattern matches
        if (!(/^\d+$/.test(startStr)) || !(/^\d+$/.test(endStr))) {
            throw new FieldParseError(`invalid range format "${value}"`, value, config.name);
        }

        if (startNum < config.min || startNum > config.max) {
            // Special case: provide clear error message for common Sunday=7 mistake
            if (config.name === "weekday" && startNum === 7) {
                throw new FieldParseError(`out of range (${config.min}-${config.max}): Sunday must be 0, not 7 (POSIX compliance)`, value, config.name);
            }
            throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
        }

        if (endNum < config.min || endNum > config.max) {
            // Special case: provide clear error message for common Sunday=7 mistake
            if (config.name === "weekday" && endNum === 7) {
                throw new FieldParseError(`out of range (${config.min}-${config.max}): Sunday must be 0, not 7 (POSIX compliance)`, value, config.name);
            }
            throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
        }

        if (startNum > endNum) {
            throw new FieldParseError(`wrap-around ranges not supported (POSIX violation) "${value}"`, value, config.name);
        }

        const mask = new Array(maskLength).fill(false);
        for (let i = startNum; i <= endNum; i++) {
            mask[i] = true;
        }
        return mask;
    }

    // Check for decimal values which are not valid in cron expressions
    if (value.includes('.')) {
        throw new FieldParseError(`decimal numbers not supported "${value}"`, value, config.name);
    }
    
    const num = parseInt(value, 10);
    if (isNaN(num)) {
        throw new FieldParseError(`invalid number "${value}"`, value, config.name);
    }
    
    // Verify the parsed number matches the original string to catch cases like "1.5" -> 1 or "1e10" -> 1e10
    // Allow leading zeros by using a specific pattern match
    if (!(/^\d+$/.test(value))) {
        throw new FieldParseError(`invalid number format "${value}"`, value, config.name);
    }

    if (num < config.min || num > config.max) {
        // Special case: provide clear error message for common Sunday=7 mistake
        if (config.name === "weekday" && num === 7) {
            throw new FieldParseError(`out of range (${config.min}-${config.max}): Sunday must be 0, not 7 (POSIX compliance)`, value, config.name);
        }
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
