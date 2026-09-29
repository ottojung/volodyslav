/**
 * The Journal store subfolder's encapsulation point.
 *
 * This module is the only import point of `journal_store`. It owns the local
 * persistence boundary of the Journal: making finalized records durable as the
 * one canonical current-format text, and reading them back through the
 * persisted-text read path so a caller can hand the result to the replay layer.
 *
 * The store keeps no ambient state of its own: it is constructed from the
 * repository's filesystem capabilities and the directory it owns, so a caller
 * cannot obtain a store which reaches the filesystem by any other route.
 */

const {
    RecordStoreClass,
    compareCoordinateText,
    isRecordStore,
    openRecordStore,
    recordPath,
} = require("./record_store");

/** @typedef {import('./record_store').RecordStoreClass} RecordStore */
/** @typedef {import('./record_store').StoreCapabilities} StoreCapabilities */

module.exports = {
    RecordStoreClass,
    compareCoordinateText,
    isRecordStore,
    openRecordStore,
    recordPath,
};
