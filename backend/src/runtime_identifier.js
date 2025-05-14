
/**
 * Generates a random identifier for the runtime.
 * Every new instance of Volodyslav will have a different identifier.
 * This is useful for tracking and debugging purposes.
 */

const random = require('./random');

function generateRandomIdentifier() {
    const seed = random.nondeterministic_seed();
    const rng = random.default_generator(seed);
    return random.string(rng);
}

const runtimeIdentifier = generateRandomIdentifier();

module.exports = runtimeIdentifier;
