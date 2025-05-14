/**
 * Generates a random identifier for the runtime.
 * Every new instance of Volodyslav will have a different identifier.
 * This is useful for tracking and debugging purposes.
 */

const { git } = require("./executables");
const { logError } = require("./logger");
const random = require("./random");
const memoize = require("@emotion/memoize").default;

let versionMemo = memoize(async () => {
    try {
        const { stdout } = await git.call("describe");
        return stdout.trim();
    } catch (e) {
        // If git is not available, we can assume that the version is unknown.
        logError({}, "Could not determine version");
        return "unknown";
    }
});

let version = () => versionMemo("");

function generateRandomIdentifier() {
    const seed = random.nondeterministic_seed();
    const rng = random.default_generator(seed);
    return random.string(rng);
}

const instanceIdentifier = generateRandomIdentifier();

const runtimeIdentifier = { version, instanceIdentifier };

module.exports = runtimeIdentifier;
