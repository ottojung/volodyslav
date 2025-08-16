/**
 * Runtime state structure and validation.
 */

const {
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidStructureError,
    TasksFieldInvalidStructureError,
    UnsupportedVersionError,
    TryDeserializeTaskError,
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    isTryDeserializeError,
    isTryDeserializeTaskError,
} = require("./errors");

/** @typedef {import('./types').RuntimeState} RuntimeState */
/** @typedef {import('./types').TaskRecord} TaskRecord */

/** Current runtime state schema version */
const RUNTIME_STATE_VERSION = 2;

/**
 * @typedef {object} DeserializeOk
 * @property {RuntimeState} state
 * @property {TryDeserializeTaskError[]} taskErrors
 * @property {boolean} migrated
 */

/**
 * Attempts to deserialize an object into a RuntimeState.
 * @param {Record<string, unknown>} obj
 * @returns {DeserializeOk | TryDeserializeError}
 */
function tryDeserialize(obj) {
    if (!obj || typeof obj !== "object") {
        return new InvalidStructureError("Runtime state must be a non-null object", obj);
    }

    const datetimeMod = require("../datetime");
    const dt = datetimeMod.make();

    const versionRaw = "version" in obj ? obj["version"] : 1;
    if (typeof versionRaw !== "number" || !Number.isInteger(versionRaw)) {
        return new InvalidTypeError("version", versionRaw, "integer");
    }
    if (versionRaw > RUNTIME_STATE_VERSION) {
        return new UnsupportedVersionError(versionRaw);
    }
    const migrated = versionRaw < RUNTIME_STATE_VERSION;

    if (!("startTime" in obj)) {
        return new MissingFieldError("startTime");
    }
    const startTimeRaw = obj["startTime"];
    if (typeof startTimeRaw !== "string") {
        return new InvalidTypeError("startTime", startTimeRaw, "string");
    }
    const startTime = dt.fromISOString(startTimeRaw);
    if (isNaN(startTime.getTime())) {
        return new InvalidTypeError("startTime", startTimeRaw, "valid ISO string");
    }

    /** @type {TaskRecord[]} */
    const tasks = [];
    /** @type {TryDeserializeTaskError[]} */
    const taskErrors = [];

    if (!migrated) {
        const rawTasks = obj["tasks"] ?? [];
        if (!Array.isArray(rawTasks)) {
            return new TasksFieldInvalidStructureError(rawTasks);
        }
        const seenNames = new Set();
        for (let i = 0; i < rawTasks.length; i++) {
            const t = rawTasks[i];
            if (!t || typeof t !== "object") {
                taskErrors.push(new TaskInvalidTypeError("task", t, "object", i));
                continue;
            }
            if (!("name" in t)) {
                taskErrors.push(new TaskMissingFieldError("name", i));
                continue;
            }
            if (typeof t.name !== "string") {
                taskErrors.push(new TaskInvalidTypeError("name", t.name, "string", i));
                continue;
            }
            if (seenNames.has(t.name)) {
                taskErrors.push(new TaskInvalidValueError("name", t.name, "unique", i));
                continue;
            }
            seenNames.add(t.name);
            if (!("cronExpression" in t)) {
                taskErrors.push(new TaskMissingFieldError("cronExpression", i));
                continue;
            }
            if (typeof t.cronExpression !== "string") {
                taskErrors.push(new TaskInvalidTypeError("cronExpression", t.cronExpression, "string", i));
                continue;
            }
            if (!("retryDelayMs" in t)) {
                taskErrors.push(new TaskMissingFieldError("retryDelayMs", i));
                continue;
            }
            if (typeof t.retryDelayMs !== "number" || !Number.isInteger(t.retryDelayMs)) {
                taskErrors.push(new TaskInvalidTypeError("retryDelayMs", t.retryDelayMs, "integer", i));
                continue;
            }
            if (t.retryDelayMs < 0) {
                taskErrors.push(new TaskInvalidValueError("retryDelayMs", t.retryDelayMs, "non-negative", i));
                continue;
            }
            /** @type {TaskRecord} */
            const rec = {
                name: t.name,
                cronExpression: t.cronExpression,
                retryDelayMs: t.retryDelayMs,
            };
            if (t.lastSuccessTime !== undefined) {
                if (typeof t.lastSuccessTime !== "string") {
                    taskErrors.push(new TaskInvalidTypeError("lastSuccessTime", t.lastSuccessTime, "string", i));
                } else {
                    const d = dt.fromISOString(t.lastSuccessTime);
                    if (isNaN(d.getTime())) {
                        taskErrors.push(new TaskInvalidValueError("lastSuccessTime", t.lastSuccessTime, "valid ISO", i));
                    } else {
                        rec.lastSuccessTime = d;
                    }
                }
            }
            if (t.lastFailureTime !== undefined) {
                if (typeof t.lastFailureTime !== "string") {
                    taskErrors.push(new TaskInvalidTypeError("lastFailureTime", t.lastFailureTime, "string", i));
                } else {
                    const d = dt.fromISOString(t.lastFailureTime);
                    if (isNaN(d.getTime())) {
                        taskErrors.push(new TaskInvalidValueError("lastFailureTime", t.lastFailureTime, "valid ISO", i));
                    } else {
                        rec.lastFailureTime = d;
                    }
                }
            }
            if (t.lastAttemptTime !== undefined) {
                if (typeof t.lastAttemptTime !== "string") {
                    taskErrors.push(new TaskInvalidTypeError("lastAttemptTime", t.lastAttemptTime, "string", i));
                } else {
                    const d = dt.fromISOString(t.lastAttemptTime);
                    if (isNaN(d.getTime())) {
                        taskErrors.push(new TaskInvalidValueError("lastAttemptTime", t.lastAttemptTime, "valid ISO", i));
                    } else {
                        rec.lastAttemptTime = d;
                    }
                }
            }
            if (t.pendingRetryUntil !== undefined) {
                if (typeof t.pendingRetryUntil !== "string") {
                    taskErrors.push(new TaskInvalidTypeError("pendingRetryUntil", t.pendingRetryUntil, "string", i));
                } else {
                    const d = dt.fromISOString(t.pendingRetryUntil);
                    if (isNaN(d.getTime())) {
                        taskErrors.push(new TaskInvalidValueError("pendingRetryUntil", t.pendingRetryUntil, "valid ISO", i));
                    } else {
                        rec.pendingRetryUntil = d;
                    }
                }
            }
            tasks.push(rec);
        }
    }

    return { state: { version: RUNTIME_STATE_VERSION, startTime, tasks }, taskErrors, migrated };
}

/**
 * Serializes a RuntimeState object.
 * @param {RuntimeState} state
 * @returns {object}
 */
function serialize(state) {
    const datetimeMod = require("../datetime");
    const dt = datetimeMod.make();
    const tasks = (state.tasks || [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => {
            /** @type {any} */
            const rec = {
                name: t.name,
                cronExpression: t.cronExpression,
                retryDelayMs: t.retryDelayMs,
            };
            if (t.lastSuccessTime) rec.lastSuccessTime = dt.toISOString(t.lastSuccessTime);
            if (t.lastFailureTime) rec.lastFailureTime = dt.toISOString(t.lastFailureTime);
            if (t.lastAttemptTime) rec.lastAttemptTime = dt.toISOString(t.lastAttemptTime);
            if (t.pendingRetryUntil) rec.pendingRetryUntil = dt.toISOString(t.pendingRetryUntil);
            return rec;
        });
    return {
        version: RUNTIME_STATE_VERSION,
        startTime: dt.toISOString(state.startTime),
        tasks,
    };
}

/**
 * Creates a default RuntimeState
 * @param {import('../datetime').Datetime} datetime
 * @returns {RuntimeState}
 */
function makeDefault(datetime) {
    return { version: RUNTIME_STATE_VERSION, startTime: datetime.now(), tasks: [] };
}

module.exports = {
    tryDeserialize,
    serialize,
    makeDefault,
    isTryDeserializeError,
    isTryDeserializeTaskError,
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidStructureError,
    TasksFieldInvalidStructureError,
    UnsupportedVersionError,
    TryDeserializeTaskError,
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    RUNTIME_STATE_VERSION,
};
