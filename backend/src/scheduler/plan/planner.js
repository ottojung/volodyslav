// @ts-check
/**
 * Pure planning functions for task scheduling.
 */

/**
 * Calculate the next eligible execution time for a task.
 * @param {import('../types').TaskDefinition} def - Task definition
 * @param {import('../types').TaskRuntime} rt - Task runtime state
 * @param {import('../types').InstantMs} now - Current time
 * @returns {import('../types').InstantMs | null} Next execution time or null if not eligible
 */
function nextEligible(def, rt, now) {
    const { isBefore } = require('../time/clock');
    
    // If task is currently running, it's not eligible
    if (rt.isRunning) {
        return null;
    }

    // Check if there's a pending retry
    if (rt.pendingRetryUntil) {
        // If retry time has passed, schedule for retry
        if (isBefore(rt.pendingRetryUntil, now) || rt.pendingRetryUntil.epochMs === now.epochMs) {
            return now;
        }
        
        // If retry is in the future, consider both retry and cron
        const cronNext = def.cron.nextAfter(now);
        
        // Return whichever comes first (earliest wins)
        if (isBefore(rt.pendingRetryUntil, cronNext)) {
            return rt.pendingRetryUntil;
        } else {
            return cronNext;
        }
    }

    // No pending retry, use cron schedule
    // For first-time tasks (lastEvaluatedFire is null), make them eligible immediately
    if (rt.lastEvaluatedFire === null) {
        return now;
    }
    
    return def.cron.nextAfter(rt.lastEvaluatedFire);
}

/**
 * Determine execution mode for a task.
 * @param {import('../types').TaskDefinition} def - Task definition
 * @param {import('../types').TaskRuntime} rt - Task runtime state
 * @param {import('../types').InstantMs} now - Current time
 * @returns {'cron' | 'retry' | null} Execution mode or null if not eligible
 */
function getExecutionMode(def, rt, now) {
    const { isBefore } = require('../time/clock');
    
    if (rt.isRunning) {
        return null;
    }

    // Check if there's a pending retry that's due
    if (rt.pendingRetryUntil) {
        if (isBefore(rt.pendingRetryUntil, now) || rt.pendingRetryUntil.epochMs === now.epochMs) {
            return 'retry';
        }
    }

    // Check if cron schedule is due
    // For first-time tasks (lastEvaluatedFire is null), consider them due immediately
    if (rt.lastEvaluatedFire === null) {
        return 'cron';
    }
    
    const cronNext = def.cron.nextAfter(rt.lastEvaluatedFire);
    
    if (isBefore(cronNext, now) || cronNext.epochMs === now.epochMs) {
        return 'cron';
    }

    return null;
}

/**
 * Check if a task is eligible for execution right now.
 * @param {import('../types').TaskDefinition} def - Task definition
 * @param {import('../types').TaskRuntime} rt - Task runtime state
 * @param {import('../types').InstantMs} now - Current time
 * @returns {boolean} True if task should execute now
 */
function isEligibleNow(def, rt, now) {
    const nextTime = nextEligible(def, rt, now);
    return nextTime !== null && nextTime.epochMs <= now.epochMs;
}

/**
 * Calculate when to schedule a retry after failure.
 * @param {import('../types').InstantMs} failureTime - When the failure occurred
 * @param {import('../types').TimeDuration} retryDelay - Retry delay duration
 * @returns {import('../types').InstantMs} When to retry
 */
function calculateRetryTime(failureTime, retryDelay) {
    const { add } = require('../time/clock');
    return add(failureTime, retryDelay);
}

module.exports = {
    nextEligible,
    getExecutionMode,
    isEligibleNow,
    calculateRetryTime,
};