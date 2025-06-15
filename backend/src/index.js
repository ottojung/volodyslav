const { gentleCall } = require("./gentlewrap");
const { start } = require("./server");
const commander = require("commander");
const runtimeIdentifier = require("./runtime_identifier");
const root = require("./capabilities/root");

/**
 * @typedef {import('./capabilities/root').Capabilities} Capabilities
 */

/**
 * @param {Capabilities} capabilities
 */
async function printVersion(capabilities) {
    const { version } = await runtimeIdentifier(capabilities);
    console.log(version);
}

/**
 * @param {Capabilities} capabilities
 */
async function entryTyped(capabilities) {
    const program = new commander.Command();

    program.name("volodyslav").description("Volodyslav Media Service CLI");

    program
        .option("-v, --version", "Display the version")
        .action(async (options) => {
            if (options.version) {
                await printVersion(capabilities);
                process.exit(0);
            }
        });

    program
        .command("start")
        .description("Start the server")
        .action(start(capabilities));

    await program.parseAsync(process.argv);

    // If we made it here then no sub‐commands or flags were used
    // so show the help and exit
    if (process.argv.slice(2).length === 0) {
        program.outputHelp(); // or .help() to print and exit
    }
}

async function entry() {
    const capabilities = root.make();
    return await gentleCall(capabilities, () => entryTyped(capabilities));
}

// Set up the command line interface with commander
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
