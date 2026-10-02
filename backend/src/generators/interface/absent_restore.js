/**
 * The absent-installation decision's restoring transition.
 *
 * The decision itself belongs to the lifecycle: which answer a recovery source
 * may give, and which answers permit startup to continue. This module owns the
 * one transition a `exists` answer authorizes.
 *
 * That transition is receiver-less: no writable receiver identity exists yet,
 * so the local storage, the writer identity and every other reconstructed fact
 * come from the held snapshot the recovery source held. It is a Journal-level
 * restoration — the held snapshot's retained records are replayed into the
 * materialized graph — and it authors no semantic event of its own.
 */

const path = require('path');
const { transaction } = require('../../gitstore');
const {
    CHECKPOINT_WORKING_PATH,
    LIVE_DATABASE_WORKING_PATH,
    journalRestoration,
    restoreAbsentFrom,
} = require('../incremental_graph');

/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */

/**
 * @typedef {{ kind: 'exists', publishedHead: string }} RecoverySourceExists
 */

/**
 * Restore a completely absent installation from the published head the recovery
 * source held.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @param {RecoverySourceExists} recovery
 * @returns {Promise<void>}
 */
async function restoreAbsentFromPublishedHead(capabilities, recovery) {
    capabilities.logger.logInfo(
        {
            hostname: capabilities.environment.hostname(),
            publishedHead: recovery.publishedHead,
        },
        'Bootstrap: installation recovery source reported a continuation-safe published head; restoring the absent installation'
    );
    await transaction(
        capabilities,
        CHECKPOINT_WORKING_PATH,
        { url: capabilities.environment.generatorsRepository() },
        async (store) => {
            await restoreAbsentFrom(capabilities, {
                workTree: await store.getWorkTree(),
                journal: journalRestoration,
                liveDatabasePath: path.join(
                    capabilities.environment.workingDirectory(),
                    LIVE_DATABASE_WORKING_PATH
                ),
            });
        }
    );
    capabilities.logger.logInfo(
        { publishedHead: recovery.publishedHead },
        'Bootstrap: absent installation restored from the published head'
    );
}

module.exports = {
    restoreAbsentFromPublishedHead,
};