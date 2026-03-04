
/**
 * @typedef {import("../../logger").Logger} Logger
 * @typedef {import("../../level_database").LevelDatabase} LevelDatabase
 * @typedef {import("../../environment").Environment} Environment
 * @typedef {import("../../filesystem/reader").FileReader} FileReader
 * @typedef {import("../../filesystem/checker").FileChecker} FileChecker
 * @typedef {import("../../filesystem/creator").FileCreator} FileCreator
 * @typedef {import("../../filesystem/deleter").FileDeleter} FileDeleter
 * @typedef {import("../../filesystem/writer").FileWriter} FileWriter
 * @typedef {import("../../subprocess/command").Command} Command
 * @typedef {import("../../sleeper").SleepCapability} SleepCapability
 * @typedef {import("../../datetime").Datetime} Datetime
 * @typedef {import("../../ai/calories").AICalories} AICalories
 */

/**
 * @typedef {object} GeneratorsCapabilities
 * @property {Logger} logger - A logger instance
 * @property {LevelDatabase} levelDatabase - A level database instance
 * @property {Environment} environment - An environment instance
 * @property {FileReader} reader - A file reader instance
 * @property {FileChecker} checker - A file checker instance
 * @property {FileCreator} creator - A file creator instance
 * @property {FileDeleter} deleter - A file deleter instance
 * @property {FileWriter} writer - A file writer instance
 * @property {Command} git - A command instance for Git operations.
 * @property {SleepCapability} sleeper - A sleeper instance.
 * @property {Datetime} datetime - Datetime utilities.
 * @property {AICalories} aiCalories - AI calories estimation capability.
 */

module.exports = {};
