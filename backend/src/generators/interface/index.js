/**
 * Interface module for generators.
 * Provides direct database operations for event storage.
 */

const { makeInterface, isInterface } = require('./class');
const { isSynchronizeDatabaseError } = require('./errors');

/** @typedef {import('./class').Interface} Interface */

module.exports = {
    makeInterface,
    isInterface,
    isSynchronizeDatabaseError,
};
