/**
 * Type definitions for Database capabilities.
 */

/** @typedef {import('../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../environment').Environment} Environment */
/** @typedef {import('../../logger').Logger} Logger */

/**
 * @typedef {object} DatabaseCapabilities
 * @property {FileChecker} checker - A file checker instance.
 * @property {FileCreator} creator - A file creator instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

module.exports = {};
