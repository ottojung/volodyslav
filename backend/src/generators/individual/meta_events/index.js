/**
 * Meta events generator module.
 * Computes the meta_events representation of event changes.
 */

const { computeMetaEvents, reconstructFromMetaEvents } = require('./compute');

/** @typedef {import('./compute').MetaEvent} MetaEvent */
/** @typedef {import('./compute').MetaEventAdd} MetaEventAdd */
/** @typedef {import('./compute').MetaEventDelete} MetaEventDelete */
/** @typedef {import('./compute').MetaEventEdit} MetaEventEdit */

module.exports = {
    computeMetaEvents,
    reconstructFromMetaEvents,
};
