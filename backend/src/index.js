const { isEnvironmentError } = require("./environment");
const { gentleWrap } = require("./gentlewrap");
const { start } = require("./server");
const logger = require("./logger");
const { Command } = require("commander");

/**
 * @returns {Promise<never>}
 */
async function entryTyped() {
    await logger.setup();
    await start();
    return process.exit(0);
}

/**
 * @type {() => Promise<never>}
 */
const entry = gentleWrap(entryTyped, [
    isEnvironmentError,
]);

/**
 * Returns the current version
 * @returns {string} The current version
 */
function version() {
    return "Volodyslav v1.0.0"; // Hardcoded version for immediate display
}

// Set up the command line interface with commander
if (require.main === module) {
    const program = new Command();

    program
        .name('volodyslav')
        .description('Volodyslav Media Service CLI')
        .version(version(), '-v, --version', 'Display the version');

    program
        .command('start')
        .description('Start the server')
        .action(() => {
            entry();
        });

    program.parse();
}

module.exports = {
    entry,
    version,
};
