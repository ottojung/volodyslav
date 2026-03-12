/**
 * Shared constants for the generators interface.
 */

/**
 * Number of events pre-cached in the `first100entries` and `last100entries`
 * graph nodes.
 *
 * When iterating sorted events via `getSortedEvents(order)`, the first
 * SORTED_EVENTS_CACHE_SIZE events are served from one of those small,
 * dedicated cache nodes.  This avoids pulling the potentially-large full
 * sorted list from LevelDB for the common case where only the first page is
 * needed (e.g. page=1, limit=50, no search filter).
 *
 * Both the graph-node computors (default_graph.js) and the iterator
 * implementation (domain_queries.js) must use the same value so that the
 * iterator's "switch-over" point aligns with what the cache nodes actually
 * store.
 */
const SORTED_EVENTS_CACHE_SIZE = 100;

module.exports = { SORTED_EVENTS_CACHE_SIZE };
