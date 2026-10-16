const { gentleCall } = require("./gentlewrap");
const { start } = require("./server");
const commander = require("commander");
const runtimeIdentifier = require("./runtime_identifier");
const root = require("./capabilities");

/**
 * @typedef {import('./capabilities/root').Capabilities} Capabilities
 * @typedef {import('./capabilities/root').RootCapabilityOptions} RootCapabilityOptions
 */

/**
 * @param {Capabilities} capabilities
 */
async function printVersion(capabilities) {
    const { version } = await runtimeIdentifier(capabilities);
    capabilities.logger.printf(version);
}

/**
 * @param {Capabilities} capabilities
 */
async function entryTyped(capabilities) {
    const program = new commander.Command();

    program.name("volodyslav").description("Volodyslav Media Service CLI");

    program
        .option("-v, --version", "Display the version")
        .argument("[cmd]", "Command to execute")
        .action(async (cmd, options) => {
            if (options.version) {
                await printVersion(capabilities);
                capabilities.exiter.exit(0);
            }
            if (cmd) {
                capabilities.logger.logError({ cmd }, `Unknown command ${JSON.stringify(cmd)}`);
                program.help({ error: true });
            } else {
                program.outputHelp();
            }
        });

    program
        .command("start")
        .description("Start the server")
        .action(start(capabilities));

    await program.parseAsync(process.argv);
}

/**
 * Start the program with the deployment configuration the deployment supplies.
 *
 * `database-lifecycle.md` §4 and `incremental-graph-journal-migrations.md` §4
 * carry the installation-recovery and canonical-bootstrap sources as deployment
 * configuration rather than persisted database state, so the deployment supplies
 * them here and they reach the Journal 3 lifecycle through the root capabilities.
 * The entry point forwards the whole configuration object unchanged; a deployment
 * which supplies none leaves the root capabilities without a source, so an absent
 * database or a supported pre-Journal replica still fails closed instead of
 * inventing state.
 *
 * @param {RootCapabilityOptions} [options] - The deployment configuration the
 *   root capabilities carry, such as the installation recovery and cohort
 *   bootstrap sources.
 * @returns {Promise<void>}
 */
async function entry(options) {
    const capabilities = root.make(options);
    return await gentleCall(capabilities, () => entryTyped(capabilities));
}

// Set up the command line interface with commander
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
