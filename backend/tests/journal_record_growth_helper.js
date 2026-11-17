/**
 * Collect the streaming journal growth of a synchronization/reset result.
 *
 * `SyncOutcome.recordGrowth` and `ResetOutcome.recordGrowth` are streaming: the
 * imported foreign suffix is re-read from the held source on demand, and the
 * production persistence front stages it record by record rather than
 * materialising it (`incremental-graph-journal-sync.md` §Streamability,
 * `incremental-graph-journal-reset.md` §Streamability). An in-memory test which
 * needs the whole delta as one array — to assert it, or to feed a reference
 * replay — asks for it here, which is the one place that materialises the growth.
 *
 * @param {{ outcome: { recordGrowth: { collect: () => Promise<ReadonlyArray<object>> } } } | object} result
 * @returns {Promise<object>}
 */
async function withCollectedRecords(result) {
    if ("outcome" in result) {
        result.outcome.records = await result.outcome.recordGrowth.collect();
    }
    return result;
}

module.exports = { withCollectedRecords };
