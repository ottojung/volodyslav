/**
 * These capabilities are created at the very top of the call stack.
 * This way, only the main entry to the program can grant these capabilities to the rest of the program.
 */

/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../exiter').Exiter} Exiter */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../notifications').Notifier} Notifier */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../sleeper').Sleeper} Sleeper */
/** @typedef {import('../scheduler').Scheduler} Scheduler */
/** @typedef {import('../runtime_state_storage').RuntimeStateStorage} RuntimeStateStorage */
/** @typedef {import('../threading').Threading} Threading */
/** @typedef {import('../wifi').WifiConnectionChecker} WifiConnectionChecker */


/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileReader} reader - A file reader instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Exiter} exiter - A process exit instance.
 * @property {Logger} logger - A logger instance.
 * @property {Notifier} notifier - A notifier instance.
 * @property {AITranscription} aiTranscription - An AI transcription instance.
 * @property {Datetime} datetime - Datetime utilities.
 * @property {Sleeper} sleeper - A sleeper instance.
 * @property {Command} volodyslavDailyTasks - A command instance for daily tasks.
 * @property {Scheduler} scheduler - A scheduler instance.
 * @property {RuntimeStateStorage} state - A runtime state storage instance.
 * @property {Threading} threading - A threading instance.
 * @property {WifiConnectionChecker} wifiChecker - A WiFi connection checker instance.
 */

const random = require("../random");
const deleterCapability = require("../filesystem/deleter");
const dirscanner = require("../filesystem/dirscanner");
const copierCapability = require("../filesystem/copier");
const creatorCapability = require("../filesystem/creator");
const writerCapability = require("../filesystem/writer");
const readerCapability = require("../filesystem/reader");
const appendCapability = require("../filesystem/appender");
const checkerCapability = require("../filesystem/checker");
const gitCapability = require("../executables").git;
const environmentCapability = require("../environment");
const loggingCapability = require("../logger");
const exiterCapability = require("../exiter");
const notifierCapability = require("../notifications");
const aiTranscriptionCapability = require("../ai/transcription");
const datetimeCapability = require("../datetime");
const sleeperCapability = require("../sleeper");
const wifiCapability = require("../wifi");
const volodyslavDailyTasks = require("../executables").volodyslavDailyTasks;
const schedule = require('../scheduler');
const runtimeStateStorage = require('../runtime_state_storage');
const threadingCapability = require('../threading');

/**
 * This structure collects maximum capabilities that any part of Volodyslav can access.
 * It is supposed to be initialized at the main entry to Volodyslav, and then passed down the call stack.
 * It should be a pure, well-behaved, non-throwing function,
 * because it is required for everything else in Volodyslav to work, including error reporting.
 */
const make = () => {
    const environment = environmentCapability.make();
    const datetime = datetimeCapability.make();
    const sleeper = sleeperCapability.make();
    const threading = threadingCapability.make();
    const wifiChecker = wifiCapability.makeWifiConnectionChecker();

    /** @type {Capabilities} */
    const ret = {
        seed: random.seed.make(),
        datetime,
        deleter: deleterCapability.make(),
        scanner: dirscanner.make(),
        copier: copierCapability.make(),
        creator: creatorCapability.make(),
        writer: writerCapability.make(),
        reader: readerCapability.make(),
        appender: appendCapability.make(),
        checker: checkerCapability.make(() => ret),
        git: gitCapability,
        environment,
        exiter: exiterCapability.make(),
        logger: loggingCapability.make(() => ret),
        notifier: notifierCapability.make(),
        aiTranscription: aiTranscriptionCapability.make(() => ret),
        sleeper,
        wifiChecker,
        volodyslavDailyTasks,
        scheduler: schedule.make(() => ({
            datetime: ret.datetime,
            logger: ret.logger,
            state: ret.state,
            threading: ret.threading,
        })),
        state: runtimeStateStorage.make(() => ret),
        threading,
    };

    return ret;
};

module.exports = {
    make,
};
