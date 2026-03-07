/**
 * Interface module for generators.
 * Provides direct database operations for event storage.
 */

const { makeInterface, isInterface, isSynchronizeDatabaseError } = require('./class');

/** @typedef {import('./class').Interface} Interface */

module.exports = {
    makeInterface,
    isInterface,
    isSynchronizeDatabaseError,
};
