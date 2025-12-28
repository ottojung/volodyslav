/**
 * DependencyGraph module for generators.
 * Provides an abstraction over the database for managing event dependencies.
 */

const { makeDependencyGraph, isDependencyGraph } = require('./class');
const { makeUnchanged, isUnchanged } = require('./unchanged');

/** @typedef {import('./types').DependencyGraphCapabilities} DependencyGraphCapabilities */
/** @typedef {import('./class').DependencyGraph} DependencyGraph */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

module.exports = {
    makeDependencyGraph,
    isDependencyGraph,
    makeUnchanged,
    isUnchanged,
};
