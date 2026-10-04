/**
 * The Journal publication front: what a computed outcome becomes on disk.
 *
 * A Journal projection becomes persisted graph bytes in exactly one place in this tree,
 * and this subfolder is that place. It holds the lowering both publication paths share —
 * `sync_publish.js` lowers `project(Jfinal)` for a synchronization, and
 * `reset_publication.js` lowers `project(Jreset)` for a reset, with the retained history a
 * reset must keep — together with the two things a reset needs around that lowering: the
 * read of a held snapshot a reset targets (`held_reset_source.js`) and the reset of a
 * receiver which retains records (`reset_receiver.js`).
 *
 * `incremental-graph-journal-reset.md` §Atomicity is one statement about one write, and it
 * is what `reset_receiver.js` and `reset_publication.js` together implement: everything a
 * reset produces lands in a single batch over the inactive replica, and the replica
 * pointer moves only after that batch has succeeded.
 *
 * It is reached from the callers which own a publication, not from the `database` barrel.
 * The Journal barrel requires `../database` and the database barrel reaches the reset
 * lifecycle, so a module which both barrels required at load time would read a half-built
 * module in whichever direction the process happened to load first. A caller which resets
 * therefore passes `resetJournalReceiverToSnapshot` into the reset operation it owns.
 */

/** @typedef {import('./held_reset_source').HeldResetSourceRequest} HeldResetSourceRequest */
/** @typedef {import('./reset_receiver').JournalResetRequest} JournalResetRequest */
/** @typedef {import('./reset_receiver').ResetReceiverToSnapshot} ResetReceiverToSnapshot */
/** @typedef {import('./reset_publication').ResetPublicationError} ResetPublicationError */
/** @typedef {import('./sync_publish').PublishableOutcome} PublishableOutcome */

const {
    planSyncPublication,
    publishSyncOutcome,
} = require("./sync_publish");

const {
    ResetSourceIsNotAJournalSnapshotError,
    isResetSourceIsNotAJournalSnapshotError,
    resetJournalReceiverToSnapshot,
} = require("./reset_receiver");

module.exports = {
    ResetSourceIsNotAJournalSnapshotError,
    isResetSourceIsNotAJournalSnapshotError,
    planSyncPublication,
    publishSyncOutcome,
    resetJournalReceiverToSnapshot,
};