/**
 * Interface module for generators.
 * Provides direct database operations for event storage.
 */

const { makeInterface, isInterface, makeInterfaceCapability, isInterfaceCapability } = require('./class');

/** @typedef {import('./class').Interface} Interface */
/** @typedef {import('./class').InterfaceCapability} InterfaceCapability */

module.exports = {
    makeInterface,
    isInterface,
    makeInterfaceCapability,
    isInterfaceCapability,
};
