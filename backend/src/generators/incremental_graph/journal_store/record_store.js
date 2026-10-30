/**
 * The durable Journal record store.
 *
 * This is the local persistence boundary of the Journal: it makes records durable
 * as the one canonical current-format text, and reads them back through the same
 * persisted-text read path replay uses. It performs every side effect through the
 * injected filesystem capabilities, so the store has no ambient filesystem access
 * and a test can drive it against a temporary directory.
 *
 * The layout is one file per record, under a per-writer subdirectory and named by
 * the record's canonical sequence coordinate:
 *
 * ```text
 * <root>/records/<author>/<sequence>
 * ```
 *
 * One file per record, keyed by coordinate, is what gives the store the ordered
 * per-writer range iteration `incremental-graph-journal-storage.md` requires, and
 * what lets a writer's retained prefix be read back one record at a time without
 * materialising any other writer's history.
 *
 * Reading a record back decodes its canonical text with `tryDecodeJournalRecord`,
 * the current-format reader. That is deliberately the only way a stored record
 * becomes a record again: replay therefore sees exactly what persistence kept, and
 * a record whose text no longer parses in the current format is reported as the
 * current-format validation error rather than repaired from mutable graph bytes.
 *
 * This module does not build an oracle `JournalSource`. It returns the retained
 * replica it read from durable storage; a caller hands that replica to the
 * replay layer, which owns how a `JournalSource` is shaped.
 */

const path = require("path");
const {
    encodeJournalRecord,
    isJournalRecord,
    journalAuthorToString,
    journalSequenceToString,
    makeJournalReplica,
    makeJournalSourceReadError,
    tryDecodeJournalRecord,
} = require("../journal");

/** @typedef {import("../journal/errors").AnyJournalError} JournalError */
/** @typedef {import("../journal/records").JournalRecord} JournalRecord */
/** @typedef {import("../journal/types").JournalAuthor} JournalAuthor */
/** @typedef {import("../journal/replica").JournalReplica} JournalReplica */
/** @typedef {import("../../../filesystem/creator").FileCreator} FileCreator */
/** @typedef {import("../../../filesystem/writer").FileWriter} FileWriter */
/** @typedef {import("../../../filesystem/reader").FileReader} FileReader */
/** @typedef {import("../../../filesystem/dirscanner").DirScanner} DirScanner */
/** @typedef {import("../../../logger").Logger} Logger */

/**
 * The filesystem capabilities the store needs. Every field is one of the
 * repository's own capability modules, so the store never reaches the ambient
 * filesystem.
 *
 * @typedef {object} StoreCapabilities
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {DirScanner} scanner
 * @property {Logger} logger
 */

/**
 * The file path one record occupies.
 * @param {string} root
 * @param {JournalAuthor} author
 * @param {string} sequenceDigits
 * @returns {string}
 */
function recordPath(root, author, sequenceDigits) {
    return path.join(root, "records", journalAuthorToString(author), sequenceDigits);
}

/**
 * Compare two canonical decimal coordinate strings numerically, so a writer's
 * directory listing is walked in writer-stream order regardless of digit count.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareCoordinateText(left, right) {
    if (left.length !== right.length) {
        return left.length - right.length;
    }
    if (left < right) {
        return -1;
    }
    return left > right ? 1 : 0;
}

/**
 * The properties that this class carries are:
 * - `capabilities` are the repository's filesystem capabilities and `root` is the
 *   directory this store owns; every side effect stays under `root` and goes
 *   through `capabilities`;
 * - `retained` names exactly the writers whose records this store has made
 *   durable, each with the greatest coordinate it retains.
 *
 * The proof of those properties is guaranteed by:
 * - `publish(records)`: writes each record's canonical text to
 *   `recordPath(root, author, sequence)` through the injected creator/writer, and
 *   updates `retained` only after that write resolves.
 *
 * The class is private to this module; callers obtain a store from
 * `openRecordStore`, so no caller can construct a store which claims durable
 * records it did not write.
 */
class RecordStoreClass {
    /**
     * @param {StoreCapabilities} capabilities
     * @param {string} root
     */
    constructor(capabilities, root) {
        this.capabilities = capabilities;
        this.root = root;
        /** @type {Map<string, {author: JournalAuthor, length: string}>} */
        this.retained = new Map();
    }

    /**
     * Make records durable, one canonical text per record.
     *
     * Records are written in the order given, which the emission finalizer has
     * already made a dependency-respecting writer-stream order.
     *
     * @param {ReadonlyArray<JournalRecord>} records
     * @returns {Promise<JournalError | undefined>}
     */
    async publish(records) {
        for (const record of records) {
            if (!isJournalRecord(record)) {
                return makeJournalSourceReadError(
                    "publication was handed a value which is not a current-format record"
                );
            }
            const author = record.id.author;
            const digits = journalSequenceToString(record.id.sequence);
            const file = recordPath(this.root, author, digits);
            try {
                const existing = await this.capabilities.creator.createFile(file);
                await this.capabilities.writer.writeFile(existing, encodeJournalRecord(record));
            } catch (error) {
                return makeJournalSourceReadError(
                    "failed to make record durable at " + file + ": " + String(error)
                );
            }
            const name = journalAuthorToString(author);
            const incumbent = this.retained.get(name);
            if (incumbent === undefined || compareCoordinateText(digits, incumbent.length) > 0) {
                this.retained.set(name, { author, length: digits });
            }
        }
        return undefined;
    }

    /**
     * The writers this store retains, in ascending author order.
     * @returns {ReadonlyArray<JournalAuthor>}
     */
    writers() {
        /** @type {Array<JournalAuthor>} */
        const authors = [];
        for (const name of [...this.retained.keys()].sort()) {
            const held = this.retained.get(name);
            if (held !== undefined) {
                authors.push(held.author);
            }
        }
        return authors;
    }

    /**
     * Read every retained record back through the persisted-text read path and
     * return them grouped by writer, in writer-stream order.
     *
     * This is a stable snapshot read of the store's committed state. It decodes
     * each stored record's canonical text with the current-format reader, so the
     * result is exactly what persistence kept rather than any in-memory record the
     * store once held. A record whose text no longer parses in the current format
     * is reported as the current-format validation error.
     *
     * @returns {Promise<JournalReplica | JournalError>}
     */
    async readReplica() {
        /** @type {Array<[JournalAuthor, Array<JournalRecord>]>} */
        const streams = [];
        for (const author of this.writers()) {
            const name = journalAuthorToString(author);
            const directory = path.join(this.root, "records", name);
            let members;
            try {
                members = await this.capabilities.scanner.scanDirectory(directory);
            } catch (error) {
                return makeJournalSourceReadError(
                    "failed to list the retained prefix of writer " + name + ": " + String(error)
                );
            }
            const coordinates = members
                .map((member) => path.basename(member.path))
                .filter((entry) => /^[0-9]+$/.test(entry))
                .sort(compareCoordinateText);
            /** @type {Array<JournalRecord>} */
            const stream = [];
            for (const coordinate of coordinates) {
                const file = path.join(directory, coordinate);
                let text;
                try {
                    text = await this.capabilities.reader.readFileAsText(file);
                } catch (error) {
                    return makeJournalSourceReadError(
                        "failed to read stored record " + file + ": " + String(error)
                    );
                }
                const record = tryDecodeJournalRecord(text);
                if (record instanceof Error) {
                    return record;
                }
                stream.push(record);
            }
            streams.push([author, stream]);
        }
        const replica = makeJournalReplica(streams);
        if (replica instanceof Error) {
            return makeJournalSourceReadError(
                "the store could not assemble a retained replica: " + replica.message
            );
        }
        return replica;
    }
}

/**
 * Open a record store rooted at `root`. The store performs no side effect until
 * `publish` is called.
 *
 * @param {StoreCapabilities} capabilities
 * @param {string} root
 * @returns {RecordStoreClass}
 */
function openRecordStore(capabilities, root) {
    return new RecordStoreClass(capabilities, root);
}

module.exports = {
    RecordStoreClass,
    compareCoordinateText,
    isRecordStore,
    openRecordStore,
    recordPath,
};

/**
 * @param {unknown} value
 * @returns {value is RecordStoreClass}
 */
function isRecordStore(value) {
    return value instanceof RecordStoreClass;
}
