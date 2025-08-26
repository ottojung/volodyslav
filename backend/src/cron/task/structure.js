
/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../time_duration').TimeDuration} TimeDuration
 * @typedef {import('../scheduling/types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../scheduling/types').Callback} Callback
 */


/**
 * FIXME: turn `Task` into a nominal type.
 * @typedef {object} Task
 * @property {string} name
 * @property {string} cronString
 * @property {import('../expression').CronExpressionClass} parsedCron
 * @property {Callback} callback
 * @property {TimeDuration} retryDelay
 * @property {DateTime|undefined} lastSuccessTime
 * @property {DateTime|undefined} lastFailureTime
 * @property {DateTime|undefined} lastAttemptTime
 * @property {DateTime|undefined} pendingRetryUntil
 * @property {DateTime|undefined} lastEvaluatedFire
 */

module.exports = {};
