/**
 * Which Jest configuration file of this repository is the global configuration
 * of the current run.
 *
 * The worker count is a global option. Jest reads it from the configuration that
 * supplies the global config, and it answers "Option maxWorkers is not supported
 * in an individual project configuration" when it finds the option inside an
 * entry of a `projects` list. So a configuration states the count when it is the
 * global configuration of the run being read, and says nothing when it is one
 * project among several, where another configuration has already resolved the
 * same value from the same variable.
 *
 * There are exactly three ways for a file in this repository to be that global
 * configuration, and each is decided from a fact Jest itself supplies: the
 * working directory Jest was started in, the configuration Jest was pointed at,
 * and the project list Jest was given. A run pointed at a configuration this
 * repository does not own - one written as JSON text on the command line, say -
 * leaves nothing to decide, and the answer is the conservative one: no
 * configuration of this repository claims a global role it cannot prove.
 */

const { existsSync, realpathSync } = require("node:fs");
const path = require("node:path");

/** The arguments Jest accepts a configuration path through. */
const CONFIGURATION_ARGUMENTS = ["--config", "-c"];

/** The argument Jest accepts a project list through. */
const PROJECT_ARGUMENTS = ["--projects"];

/**
 * @param {string} argument
 * @returns {{ name: string, inlineValue: string | undefined }}
 */
function splitArgument(argument) {
    const equalsSign = argument.indexOf("=");
    if (equalsSign < 0) {
        return { name: argument, inlineValue: undefined };
    }
    return { name: argument.slice(0, equalsSign), inlineValue: argument.slice(equalsSign + 1) };
}

/**
 * The values this process was given for any of `names`, in the order they appear.
 *
 * The properties that this function carries are:
 * - every returned value came from this process's own command line, immediately
 *   after one of `names` or joined to it with an equals sign.
 * - a value is not returned when the argument after `names` is itself an option,
 *   because then Jest was given the option without a value.
 *
 * The proof of those properties is guaranteed by:
 * - `optionValues(...)`: reads `process.argv` past the executable, which is the
 *   argument vector Jest parses its own options from, and returns a value only
 *   for the element following an argument whose name is in `names` or for the
 *   text after an equals sign in such an argument.
 * - `optionValues(...)`: stops at the element `--`, which ends option parsing,
 *   and at an element beginning with a hyphen, which is an option rather than a
 *   value.
 *
 * @param {readonly string[]} names
 * @returns {string[]}
 */
function optionValues(names) {
    const commandArguments = process.argv.slice(1);
    /** @type {string[]} */
    const values = [];
    let awaitingValue = false;

    for (const argument of commandArguments) {
        if (awaitingValue) {
            if (argument.startsWith("-")) {
                awaitingValue = false;
                continue;
            }
            values.push(argument);
            continue;
        }

        if (argument === "--") {
            break;
        }

        const { name, inlineValue } = splitArgument(argument);
        if (!names.includes(name)) {
            continue;
        }
        if (inlineValue === undefined) {
            awaitingValue = true;
            continue;
        }
        values.push(inlineValue);
    }

    return values;
}

/**
 * The real paths among `values` that name something that exists.
 *
 * A value Jest takes as text rather than as a path - a configuration written as
 * JSON - is skipped, because it names no file this repository can compare.
 *
 * @param {string[]} values
 * @returns {string[]}
 */
function realPathsAmong(values) {
    /** @type {string[]} */
    const paths = [];

    for (const value of values) {
        if (value.startsWith("{")) {
            continue;
        }
        const resolved = path.resolve(value);
        if (existsSync(resolved)) {
            paths.push(realpathSync(resolved));
        }
    }

    return paths;
}

/**
 * @param {string} target
 * @param {string} configuration
 * @returns {boolean}
 */
function covers(target, configuration) {
    return configuration === target || configuration.startsWith(target + path.sep);
}

/**
 * Whether a Jest configuration file is the global configuration of the current
 * run, and therefore the place where the worker count may be stated.
 *
 * A file answers yes when Jest was started in the directory it resolves from,
 * when Jest was pointed at it or at a directory containing it, or when Jest was
 * given a single project naming it and named no other configuration - the last
 * because a project list of one given on the command line leaves the
 * repository's own configuration out of the run, so the configuration it names
 * becomes the whole global config. A project list of more than one does not: Jest
 * then builds its global config from the first of them and reads the rest as
 * individual projects, and this repository's configurations say nothing about
 * which of the two a given file is.
 *
 * Everything else answers no, including a run pointed at a configuration this
 * repository does not own.
 *
 * Both sides are compared as real paths because Jest compares its working
 * directory and its configuration path the same way, and a symbolic link in the
 * path would otherwise make this answer false for a run started in the intended
 * directory.
 *
 * @param {string} configurationFile - path of the configuration file being read.
 * @returns {boolean}
 */
function isGlobalConfigurationOfThisRun(configurationFile) {
    const configuration = realpathSync(configurationFile);

    if (realpathSync(process.cwd()) === path.dirname(configuration)) {
        return true;
    }

    const pointedAt = optionValues(CONFIGURATION_ARGUMENTS);
    if (realPathsAmong(pointedAt).some((target) => covers(target, configuration))) {
        return true;
    }

    if (pointedAt.length > 0) {
        return false;
    }

    const projects = optionValues(PROJECT_ARGUMENTS);
    if (projects.length !== 1) {
        return false;
    }

    return realPathsAmong(projects).some((target) => covers(target, configuration));
}

module.exports = {
    isGlobalConfigurationOfThisRun,
};
