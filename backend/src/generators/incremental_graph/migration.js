
// This file contains the current migration callback.

const { stringToNodeName } = require("./database");
const { deserializeNodeKey } = require("./node_key");

/**
 * @typedef {import('../interface/types').GeneratorsCapabilities} GeneratorsCapabilities
 */

/**
 * @typedef {import('./migration_storage').MigrationStorage} MigrationStorage
 */

/**
 * @typedef {import('./errors').NodeKeyString} NodeKeyString
 */

/**
 * @typedef {import('./database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry
 */

/**
 * A migration callback that keeps all nodes of a certain type.
 *
 * @param {string} nodeName - The name of the node type to keep (e.g., "meta_events")
 * @param {MigrationStorage} storage - The migration storage instance
 * @returns {Promise<void>}
 */
async function keepNodeType(nodeName, storage) {
    const nodeNameTyped = stringToNodeName(nodeName);
    const nodeKeys = storage.listMaterializedNodes();
    for await (const nodeKey of nodeKeys) {
        const parsed = deserializeNodeKey(nodeKey);
        if (parsed.head === nodeNameTyped) {
            await storage.keep(nodeKey);
        }
    }
}

/**
 * A migration callback that deletes all nodes of a certain type.
 *
 * @param {string} nodeName - The name of the node type to delete (e.g., "meta_events")
 * @param {MigrationStorage} storage - The migration storage instance
 * @returns {Promise<void>}
 */
async function deleteNodeType(nodeName, storage) {
    const nodeNameTyped = stringToNodeName(nodeName);
    const nodeKeys = storage.listMaterializedNodes();
    for await (const nodeKey of nodeKeys) {
        const parsed = deserializeNodeKey(nodeKey);
        if (parsed.head === nodeNameTyped) {
            await storage.delete(nodeKey);
        }
    }
}

/**
 * @param {GeneratorsCapabilities} capabilities
 * @returns {function(MigrationStorage): Promise<void>}
 */
function migrationCallback(capabilities) {
    return async (storage) => {
        capabilities.logger.logInfo({}, "Migration tries to keep everything.");
        await keepNodeType("all_events", storage);
        await keepNodeType("sorted_events_descending", storage);
        await keepNodeType("sorted_events_ascending", storage);
        await keepNodeType("last_entries", storage);
        await keepNodeType("first_entries", storage);
        await keepNodeType("events_count", storage);
        await keepNodeType("config", storage);
        await keepNodeType("meta_events", storage);
        await keepNodeType("event", storage);
        await keepNodeType("basic_context", storage);
        await keepNodeType("calories", storage);
        await keepNodeType("event_transcription", storage);
        await keepNodeType("transcription", storage);
        await keepNodeType("event_audios_list", storage);

        await deleteNodeType("entry_diary_content", storage);

        const nodeNameTyped = stringToNodeName("diary_most_important_info_summary");
        const nodeKeys = storage.listMaterializedNodes();
        for await (const nodeKey of nodeKeys) {
            const parsed = deserializeNodeKey(nodeKey);
            if (parsed.head === nodeNameTyped) {
                /** @type {(nodeKey: NodeKeyString) => Promise<DiaryMostImportantInfoSummaryEntry>} */
                const transform = async (nodeKey) => {
                    const currentValue = await storage.get(nodeKey);
                    if (!currentValue) {
                        throw new Error(`Unexpected missing value for node key ${nodeKey}`);
                    }

                    if (JSON.stringify(Object.keys(currentValue).sort()) !== JSON.stringify(['type', 'markdown', 'summaryDate', 'processedTranscriptions', 'updatedAt', 'model', 'version'].sort())) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: has unexpected fields: ${Object.keys(currentValue)}`);
                    }

                    if (!('markdown' in currentValue)) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: missing 'markdown' field`);
                    }
                    if (!('summaryDate' in currentValue)) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: missing 'summaryDate' field`);
                    }
                    if (!('updatedAt' in currentValue)) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: missing 'updatedAt' field`);
                    }
                    if (!('model' in currentValue)) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: missing 'model' field`);
                    }
                    if (!('version' in currentValue)) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: missing 'version' field`);
                    }
                    if (typeof currentValue.markdown !== 'string') {
                        throw new Error(`Unexpected node value for key ${nodeKey}: 'markdown' field is not a string`);
                    }
                    if (typeof currentValue.summaryDate !== 'string') {
                        throw new Error(`Unexpected node value for key ${nodeKey}: 'summaryDate' field is not a string`);
                    }
                    if (typeof currentValue.updatedAt !== 'string') {
                        throw new Error(`Unexpected node value for key ${nodeKey}: 'updatedAt' field is not a string`);
                    }
                    if (typeof currentValue.model !== 'string') {
                        throw new Error(`Unexpected node value for key ${nodeKey}: 'model' field is not a string`);
                    }
                    if (typeof currentValue.version !== 'string') {
                        throw new Error(`Unexpected node value for key ${nodeKey}: 'version' field is not a string`);
                    }

                    if (!('processedTranscriptions' in currentValue)) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: missing 'processedTranscriptions' field`);
                    }
                    if (typeof currentValue.processedTranscriptions !== 'object' || currentValue.processedTranscriptions === null) {
                        throw new Error(`Unexpected node value for key ${nodeKey}: 'processedTranscriptions' field is not an object`);
                    }

                    /** @type {Record<string, string>} */
                    const processedEntries = {};
                    for (const [audioPath, value] of Object.entries(currentValue.processedTranscriptions)) {
                        if (typeof audioPath !== 'string') {
                            throw new Error(`Unexpected node value for key ${nodeKey}: 'processedTranscriptions' field contains non-string entry`);
                        }

                        const parts = audioPath.split('/');
                        if (parts.length !== 4) {
                            throw new Error(`Unexpected audio path in 'processedTranscriptions' for key ${nodeKey}: expected 4 parts separated by '/', got ${parts.length}`);
                        }

                        const [yearMonth, day, entryId, basename] = parts;
                        if (typeof entryId !== 'string') {
                            throw new Error(`Unexpected node value for key ${nodeKey}: 'processedTranscriptions' field contains entry with non-string entryId`);
                        }
                        if (typeof basename !== 'string') {
                            throw new Error(`Unexpected node value for key ${nodeKey}: 'processedTranscriptions' field contains entry with non-string basename`);
                        }
                        if (typeof yearMonth !== 'string') {
                            throw new Error(`Unexpected node value for key ${nodeKey}: 'processedTranscriptions' field contains entry with non-string yearMonth`);
                        }
                        if (typeof day !== 'string') {
                            throw new Error(`Unexpected node value for key ${nodeKey}: 'processedTranscriptions' field contains entry with non-string day`);
                        }
                        processedEntries[entryId] = value;
                    }

                    /** @type {DiaryMostImportantInfoSummaryEntry} */
                    const ret = {
                        type: 'diary_most_important_info_summary',
                        markdown: currentValue.markdown,
                        summaryDate: currentValue.summaryDate,
                        processedEntries,
                        updatedAt: currentValue.updatedAt,
                        model: currentValue.model,
                        version: currentValue.version,
                    };

                    return ret;
                };

                await storage.override(nodeKey, transform);
            }
        }
    };
}

/**
 * Deletes all node values.
 * @param {GeneratorsCapabilities} capabilities
 * @param {MigrationStorage} storage
 * @returns {Promise<void>}
 */
async function deleteAllCallback(capabilities, storage) {
    // A conservative approach.
    // The effect is that all computed values will be invalidated.
    capabilities.logger.logInfo({}, "Migration: deleting all node values");
    for await (const nodeKey of storage.listMaterializedNodes()) {
        await storage.delete(nodeKey);
    }
}

module.exports = {
    deleteAllCallback,
    migrationCallback,
    keepNodeType,
    deleteNodeType,
};
