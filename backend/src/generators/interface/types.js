
/**
 * @typedef {import("../../logger").Logger} Logger
 * @typedef {import("../../level_database").LevelDatabase} LevelDatabase
 * @typedef {import("../../environment").Environment} Environment
 * @typedef {import("../../filesystem/reader").FileReader} FileReader
 * @typedef {import("../../filesystem/checker").FileChecker} FileChecker
 * @typedef {import("../../subprocess/command").Command} Command
 */

/**
 * @typedef {object} GeneratorsCapabilities
 * @property {Logger} logger - A logger instance
 * @property {LevelDatabase} levelDatabase - A level database instance
 * @property {Environment} environment - An environment instance
 * @property {FileReader} reader - A file reader instance
 * @property {FileChecker} checker - A file checker instance
 * @property {Command} git - A command instance for Git operations.
 */

module.exports = {};
