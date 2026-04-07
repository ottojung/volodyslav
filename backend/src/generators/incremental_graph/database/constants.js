/**
 * Shared constants for the incremental-graph database.
 */

/**
 * Maximum number of LevelDB batch operations per single db.batch() call.
 * Keeping individual batches bounded prevents memory spikes during large
 * restores, replica copies, hostname imports, and merge writes.
 *
 * @type {number}
 */
const RAW_BATCH_CHUNK_SIZE = 500;

module.exports = { RAW_BATCH_CHUNK_SIZE };
