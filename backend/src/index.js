const { gentleWrap } = require("./gentlewrap");
const { start } = require("./server");
const logger = require("./logger");
const { Command } = require("commander");
const userErrors = require("./user_errors");

async function printVersion() {
    const { version } = require("./runtime_identifier");
    console.log(await version());
}

async function entryTyped() {
    await logger.setup();
    const program = new Command();

    program.name("volodyslav").description("Volodyslav Media Service CLI");

    program
        .option("-v, --version", "Display the version")
        .action(async (options) => {
            if (options.version) {
                await printVersion();
                process.exit(0);
            }
        });

    program.command("start").description("Start the server").action(start);

    await program.parseAsync(process.argv);

    // If we made it here then no sub‐commands or flags were used
    // so show the help and exit
    if (process.argv.slice(2).length === 0) {
        program.outputHelp(); // or .help() to print and exit
    }
}

/**
 * @type {() => Promise<void>}
 */
const entry = gentleWrap(entryTyped, userErrors);

// Set up the command line interface with commander
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
