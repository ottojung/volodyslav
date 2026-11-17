/**
 * The greatest authority time the observed union `J0` carries, read from committed
 * metadata rather than by scanning either retained journal.
 *
 * A synchronization and a reset both observe `J0 = JR ∪ imported foreign suffixes`,
 * and both allocate their receiver-authored normalization records strictly above the
 * greatest authority time `J0` carries so an authored record can never share or
 * precede the authority of a record it observed.
 * `incremental-graph-journal-types.md` §Ordinary authority allocation defines every
 * writable database's committed high-water `H` as at least the greatest
 * `AuthorityTime` among the semantic events it has observed, and
 * `incremental-graph-journal-storage.md` §Committed-pair metadata persists `H`
 * atomically with the pair it describes so a reader obtains it without scanning
 * retained history. Every record of the receiver's retained journal is one the
 * receiver's writer observed, and every imported record is one the held snapshot's
 * writer observed, so `J0`'s greatest authority time is at most the greater of the
 * two committed high-waters.
 *
 * This module exists so that the bound is met by construction:
 * `incremental-graph-journal-storage.md` §Synchronization/reset validation requires a
 * synchronization or reset to use retained indexes and committed metadata and to leave
 * unrelated retained history unrescanned, and `incremental-graph-journal-sync.md`
 * §Streamability states the same for historical work attributable to a
 * synchronization. Reading the two committed values is `O(1)` in retained history,
 * whereas folding the source's records to find the same maximum would read the
 * complete source overlap the immutable-overlap law already guarantees is shared with
 * the receiver.
 */

/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */

const { compareAuthorityTime } = require('../journal');

/**
 * The properties that this function carries are:
 * - the returned `AuthorityTime` is greater than or equal to both committed
 *   high-waters it is given, and is one of them.
 *
 * The proof of those properties is guaranteed by:
 * - `greatestObservedHighWater(...)`: it returns the source high-water exactly when
 *   `compareAuthorityTime` orders it strictly after the receiver high-water, and the
 *   receiver high-water otherwise, so the result is the maximum of the two.
 *
 * @param {AuthorityTime} receiverHighWater - The receiver's committed high-water.
 * @param {AuthorityTime} sourceHighWater - The held snapshot's committed high-water.
 * @returns {AuthorityTime}
 */
function greatestObservedHighWater(receiverHighWater, sourceHighWater) {
    return compareAuthorityTime(sourceHighWater, receiverHighWater) > 0
        ? sourceHighWater
        : receiverHighWater;
}

module.exports = {
    greatestObservedHighWater,
};
