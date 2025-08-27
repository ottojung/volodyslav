// @ts-check
/**
 * Task signature creation and comparison for detecting configuration drift.
 */

/**
 * @typedef {object} TaskSignature
 * @property {string} name
 * @property {string} cron
 * @property {number} retryDelay
 */

/**
 * @typedef {object} RegistrySignature
 * @property {TaskSignature[]} tasks
 * @property {number} count
 * @property {string} hash
 */

/**
 * @typedef {object} ComparisonResult
 * @property {boolean} hasDifferences
 * @property {string} summary
 * @property {object} details
 * @property {string[]} details.missing
 * @property {string[]} details.extra
 * @property {object[]} details.modified
 */

/**
 * Create a canonical signature for a set of task definitions.
 * @param {Array<import('../types').TaskDefinition>} tasks
 * @returns {RegistrySignature}
 */
function createSignature(tasks) {
    const { toString } = require('../value-objects/task-id');
    const { toJSON } = require('../value-objects/cron-expression/serialize');
    
    // Convert to comparable format
    const taskSigs = tasks.map(task => ({
        name: toString(task.name),
        cron: toJSON(task.cron),
        retryDelay: task.retryDelay.toMs(),
    }));
    
    // Sort by name for order independence
    taskSigs.sort((a, b) => a.name.localeCompare(b.name));
    
    return {
        tasks: taskSigs,
        count: taskSigs.length,
        hash: hashTasks(taskSigs),
    };
}

/**
 * Compare two signatures.
 * @param {RegistrySignature} sig1
 * @param {RegistrySignature} sig2
 * @returns {ComparisonResult} Comparison result
 */
function compareSignatures(sig1, sig2) {
    /** @type {{missing: string[], extra: string[], modified: object[]}} */
    const differences = {
        missing: [],
        extra: [],
        modified: [],
    };
    
    // Create lookup maps
    const tasks1 = new Map(sig1.tasks.map((/** @type {TaskSignature} */ t) => [t.name, t]));
    const tasks2 = new Map(sig2.tasks.map((/** @type {TaskSignature} */ t) => [t.name, t]));
    
    // Find missing tasks (in sig1 but not sig2)
    for (const [name] of tasks1) {
        if (!tasks2.has(name)) {
            differences.missing.push(name);
        }
    }
    
    // Find extra tasks (in sig2 but not sig1)
    for (const [name] of tasks2) {
        if (!tasks1.has(name)) {
            differences.extra.push(name);
        }
    }
    
    // Find modified tasks (in both but different)
    for (const [name, task1] of tasks1) {
        const task2 = tasks2.get(name);
        if (task2 && !tasksEqual(task1, task2)) {
            differences.modified.push({
                name,
                old: task2,
                new: task1,
            });
        }
    }
    
    const hasDifferences = differences.missing.length > 0 || 
                          differences.extra.length > 0 || 
                          differences.modified.length > 0;
    
    return {
        hasDifferences,
        details: differences,
        summary: createSummary(differences),
    };
}

/**
 * Check if two task definitions are equal.
 * @param {TaskSignature} task1
 * @param {TaskSignature} task2
 * @returns {boolean}
 */
function tasksEqual(task1, task2) {
    return task1.name === task2.name &&
           task1.cron === task2.cron &&
           task1.retryDelay === task2.retryDelay;
}

/**
 * Create a hash for a set of tasks.
 * @param {TaskSignature[]} tasks
 * @returns {string}
 */
function hashTasks(tasks) {
    // Simple string-based hash for deterministic comparison
    const str = JSON.stringify(tasks);
    let hash = 0;
    
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    
    return hash.toString(16);
}

/**
 * Create a summary of differences.
 * @param {{missing: string[], extra: string[], modified: object[]}} differences
 * @returns {string}
 */
function createSummary(differences) {
    const parts = [];
    
    if (differences.missing.length > 0) {
        parts.push(`${differences.missing.length} task(s) missing from persisted state`);
    }
    
    if (differences.extra.length > 0) {
        parts.push(`${differences.extra.length} extra task(s) in persisted state`);
    }
    
    if (differences.modified.length > 0) {
        parts.push(`${differences.modified.length} task(s) modified`);
    }
    
    return parts.join(', ');
}

/**
 * Create a detailed difference report.
 * @param {{missing: string[], extra: string[], modified: object[]}} differences
 * @returns {string}
 */
function createDetailedReport(differences) {
    const lines = [];
    
    if (differences.missing.length > 0) {
        lines.push("Missing tasks:");
        for (const name of differences.missing) {
            lines.push(`  - ${name}`);
        }
    }
    
    if (differences.extra.length > 0) {
        lines.push("Extra tasks:");
        for (const name of differences.extra) {
            lines.push(`  + ${name}`);
        }
    }
    
    if (differences.modified.length > 0) {
        lines.push("Modified tasks:");
        for (const mod of differences.modified) {
            lines.push(`  ~ ${mod.name}`);
            if (mod.old.cron !== mod.new.cron) {
                lines.push(`    cron: "${mod.old.cron}" → "${mod.new.cron}"`);
            }
            if (mod.old.retryDelay !== mod.new.retryDelay) {
                lines.push(`    retryDelay: ${mod.old.retryDelay}ms → ${mod.new.retryDelay}ms`);
            }
        }
    }
    
    return lines.join('\n');
}

module.exports = {
    createSignature,
    compareSignatures,
    tasksEqual,
    hashTasks,
    createSummary,
    createDetailedReport,
};