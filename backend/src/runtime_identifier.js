/**
 * Generates a random identifier for the runtime.
 * Every new instance of Volodyslav will have a different identifier.
 * This is useful for tracking and debugging purposes.
 */

const { git } = require("./executables");
const { logError } = require("./logger");
const memconst = require("./memconst");
const random = require("./random");

let version = memconst(async () => {
    git.ensureAvailable();
    try {
        const repositoryPath = __dirname;
        const { stdout } = await git.call("-C", repositoryPath, "describe");
        return stdout.trim();
    } catch (error) {
        // If git is not available, we can assume that the version is unknown.
        const message = error instanceof Error ? error.message : String(error);
        logError({ error }, `Could not determine version: ${message}`);
        return "unknown";
    }
});

function generateRandomIdentifier() {
    const seed = random.nondeterministic_seed();
    const rng = random.default_generator(seed);
    return random.string(rng);
}

const instanceIdentifier = generateRandomIdentifier();

const runtimeIdentifier = { version, instanceIdentifier };

module.exports = runtimeIdentifier;
