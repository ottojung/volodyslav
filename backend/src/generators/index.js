/**
 * Generators module.
 * Provides the incremental graph interface for event-driven computation.
 */

const { makeInterface, isInterface } = require('./interface');

/** @typedef {import('./interface').Interface} Interface */

module.exports = {
    makeInterface,
    isInterface,
};
