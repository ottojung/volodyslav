/**
 * DependencyGraph module for generators.
 * Provides an abstraction over the database for managing event dependencies.
 */

const { makeDependencyGraph, isDependencyGraph } = require('./class');

/** @typedef {import('./types').DependencyGraphCapabilities} DependencyGraphCapabilities */
/** @typedef {import('./class').DependencyGraph} DependencyGraph */

module.exports = {
    makeDependencyGraph,
    isDependencyGraph,
};
