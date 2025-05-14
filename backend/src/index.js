const { isEnvironmentError } = require("./environment");
const { gentleWrap } = require("./gentlewrap");
const { start } = require("./server");
const logger = require("./logger");
const { Command } = require("commander");

async function printVersion() {
    const { version } = require("./runtime_identifier");
    console.log(`Version: ${version()}`);
}

/**
 * @returns {Promise<never>}
 */
async function entryTyped() {
    await logger.setup();
    const program = new Command();

    program.name("volodyslav").description("Volodyslav Media Service CLI");

    program
        .command("version, -v, --version")
        .description("Display the version")
        .action(printVersion);

    program.command("start").description("Start the server").action(start);

    program.parse();

    return process.exit(0);
}

/**
 * @type {() => Promise<never>}
 */
const entry = gentleWrap(entryTyped, [isEnvironmentError]);

// Set up the command line interface with commander
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
