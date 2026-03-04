/**
 * Generators module.
 * Provides the incremental graph interface for event-driven computation.
 */

const { makeInterface, isInterface, makeInterfaceCapability, isInterfaceCapability } = require('./interface');

/** @typedef {import('./interface').Interface} Interface */
/** @typedef {import('./interface').InterfaceCapability} InterfaceCapability */

module.exports = {
    makeInterface,
    isInterface,
    makeInterfaceCapability,
    isInterfaceCapability,
};
