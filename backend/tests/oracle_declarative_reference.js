/**
 * A second, deliberately naive projector, written from the replay
 * specification's declarative text rather than from the streaming oracle.
 *
 * This exists so the oracle can be *disagreed with*. `incremental-graph-journal-testing.md`
 * §Reference replay oracle asks for a reference model that optimized replay is
 * checked against, and the previous front's acceptance test had the property that
 * it could fail because it transcribed a different reader's semantics. A journal
 * oracle needs the same property, and a second implementation of the same
 * specification is the way to get it.
 *
 * This model groups the whole journal by node in RAM, keeps complete per-node
 * history, and evaluates the specification's set definitions literally:
 * `History(K)`, `HeadCandidates(K)`, `Validations(K)`, and the three
 * `uncovered*` set existentials. It is the shape the specification says a
 * reference model is *allowed* to have — "Complete-history replay remains a valid
 * algorithm for ... the reference oracle" — precisely so that it is not the
 * streaming shape whose correctness is in question.
 *
 * Nothing in `backend/src` depends on this file. It is test material.
 */

const {
    authorityCompare,
    happenedBefore,
    isDeleteEvent,
    isInvalidateEvent,
    isValidateEvent,
    isValueEvent,
    isWriterStateRecord,
    journalRecordIdToString,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

/** @typedef {import("../src/generators/incremental_graph/journal").JournalRecord} JournalRecord */

/**
 * Every retained record of every writer, gathered into one list.
 * @param {import("../src/generators/incremental_graph/journal").JournalReplica} replica
 * @returns {JournalRecord[]}
 */
function allRecordsOf(replica) {
    /** @type {JournalRecord[]} */
    const records = [];
    for (const stream of replica) {
        for (const record of stream[1]) {
            records.push(record);
        }
    }
    return records;
}

/**
 * `History(K) = all retained SemanticEvents whose node == K`, as a literal array.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @returns {JournalRecord[]}
 */
function historyOf(records, nodeKeyString) {
    return records.filter(
        (record) =>
            "node" in record && nodeKeyToCanonicalString(record.node) === nodeKeyString
    );
}

/**
 * `HeadCandidates(K) = ValueEvents(K) union DeleteEvents(K)`, and
 * `head(K) = greatest HeadCandidate by authorityCompare`.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @returns {JournalRecord | undefined}
 */
function headCandidateOf(records, nodeKeyString) {
    const candidates = historyOf(records, nodeKeyString).filter(
        (record) => isValueEvent(record) || isDeleteEvent(record)
    );
    let head;
    for (const candidate of candidates) {
        if (head === undefined || authorityCompare(candidate, head) > 0) {
            head = candidate;
        }
    }
    return head;
}

/**
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecordId | undefined}
 */
function valueIdOf(records, nodeKeyString) {
    const head = headCandidateOf(records, nodeKeyString);
    if (head === undefined || !isValueEvent(head)) {
        return undefined;
    }
    return head.id;
}

/**
 * `uncoveredNodeInvalidation(K,C)`, evaluated as the specification's literal
 * existential over `History(K)` with the specification's own `happenedBefore`.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @param {JournalRecord} certificate
 * @returns {boolean}
 */
function uncoveredNodeInvalidation(records, nodeKeyString, certificate) {
    return historyOf(records, nodeKeyString).some(
        (record) =>
            isInvalidateEvent(record) &&
            record.scope.kind === "node" &&
            !happenedBefore(record, certificate)
    );
}

/**
 * `uncoveredValueInvalidation(K,C)`, as a literal existential.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @param {JournalRecord} certificate
 * @returns {boolean}
 */
function uncoveredValueInvalidation(records, nodeKeyString, certificate) {
    const valueId = valueIdOf(records, nodeKeyString);
    if (valueId === undefined) {
        return true;
    }
    return historyOf(records, nodeKeyString).some(
        (record) =>
            isInvalidateEvent(record) &&
            record.scope.kind === "value" &&
            journalRecordIdToString(record.scope.value) === journalRecordIdToString(valueId) &&
            !happenedBefore(record, certificate)
    );
}

/**
 * `uncoveredProofBarrier(K,D,C)`, as a literal existential.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @param {string} inputKeyString
 * @param {JournalRecord} certificate
 * @returns {boolean}
 */
function uncoveredProofBarrier(records, nodeKeyString, inputKeyString, certificate) {
    const valueId = valueIdOf(records, nodeKeyString);
    if (valueId === undefined) {
        return true;
    }
    return historyOf(records, nodeKeyString).some(
        (record) =>
            isInvalidateEvent(record) &&
            record.scope.kind === "proof" &&
            journalRecordIdToString(record.scope.value) === journalRecordIdToString(valueId) &&
            nodeKeyToCanonicalString(record.scope.input) === inputKeyString &&
            !happenedBefore(record, certificate)
    );
}

/**
 * `current-shape-compatible(C,K)`: `certificateInputs(C) == currentInputs(K)`.
 * @param {JournalRecord} certificate
 * @param {ReadonlyArray<string>} currentInputs
 * @returns {boolean}
 */
function currentShapeCompatible(certificate, currentInputs) {
    const declared = certificate.basis.map((entry) => nodeKeyToCanonicalString(entry.input));
    if (new Set(declared).size !== declared.length) {
        return false;
    }
    const expected = [...currentInputs].sort();
    const actual = [...declared].sort();
    return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/**
 * `basisValue(C,D)`.
 * @param {JournalRecord} certificate
 * @param {string} inputKeyString
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecordId | "unknown" | undefined}
 */
function basisValueOf(certificate, inputKeyString) {
    for (const entry of certificate.basis) {
        if (nodeKeyToCanonicalString(entry.input) === inputKeyString) {
            return entry.value;
        }
    }
    return undefined;
}

/**
 * `eligibleCertificate(K,C)` and, for an eligible candidate, its two ordering
 * keys. The candidate is scored exactly as the specification orders it.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @param {ReadonlyArray<string>} currentInputs
 * @param {JournalRecord} certificate
 * @returns {{effectiveCount: number, coversValue: boolean} | undefined}
 */
function scoreCertificate(records, nodeKeyString, currentInputs, certificate) {
    const valueId = valueIdOf(records, nodeKeyString);
    if (valueId === undefined) {
        return undefined;
    }
    if (journalRecordIdToString(certificate.value) !== journalRecordIdToString(valueId)) {
        return undefined;
    }
    if (!currentShapeCompatible(certificate, currentInputs)) {
        return undefined;
    }
    if (uncoveredNodeInvalidation(records, nodeKeyString, certificate)) {
        return undefined;
    }
    let effectiveCount = 0;
    for (const inputKeyString of currentInputs) {
        const claimed = basisValueOf(certificate, inputKeyString);
        if (claimed === undefined || claimed === "unknown") {
            continue;
        }
        const inputValueId = valueIdOf(records, inputKeyString);
        if (inputValueId === undefined) {
            continue;
        }
        if (journalRecordIdToString(claimed) !== journalRecordIdToString(inputValueId)) {
            continue;
        }
        if (uncoveredProofBarrier(records, nodeKeyString, inputKeyString, certificate)) {
            continue;
        }
        effectiveCount++;
    }
    return {
        effectiveCount,
        coversValue: !uncoveredValueInvalidation(records, nodeKeyString, certificate),
    };
}

/**
 * `Validations(K)`, as a literal set of retained certificates for the current
 * occurrence.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @returns {JournalRecord[]}
 */
function validationsOf(records, nodeKeyString) {
    const valueId = valueIdOf(records, nodeKeyString);
    if (valueId === undefined) {
        return [];
    }
    return historyOf(records, nodeKeyString).filter(
        (record) =>
            isValidateEvent(record) &&
            nodeKeyToCanonicalString(record.node) === nodeKeyString &&
            journalRecordIdToString(record.value) === journalRecordIdToString(valueId)
    );
}

/**
 * `certificate(K)`: the eligible candidate maximising, in order, the effective
 * basis match count, then `coversValueInvalidations`, then authority.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @param {ReadonlyArray<string>} currentInputs
 * @returns {{certificate: JournalRecord, effectiveInputs: Set<string>, coversValue: boolean} | undefined}
 */
function selectedCertificateOf(records, nodeKeyString, currentInputs) {
    let best;
    for (const candidate of validationsOf(records, nodeKeyString)) {
        const score = scoreCertificate(records, nodeKeyString, currentInputs, candidate);
        if (score === undefined) {
            continue;
        }
        if (best === undefined) {
            best = { candidate, score };
            continue;
        }
        if (score.effectiveCount !== best.score.effectiveCount) {
            if (score.effectiveCount > best.score.effectiveCount) {
                best = { candidate, score };
            }
            continue;
        }
        if (score.coversValue !== best.score.coversValue) {
            if (score.coversValue) {
                best = { candidate, score };
            }
            continue;
        }
        if (authorityCompare(candidate, best.candidate) > 0) {
            best = { candidate, score };
        }
    }
    if (best === undefined) {
        return undefined;
    }
    /**
     * `basisEntryEffective(K,C,D)` is a conjunction: the basis entry must name
     * the input's *current* ValueId, and no uncovered proof barrier may suppress
     * the edge. Recomputing the winning certificate's effective inputs therefore
     * has to apply both conjuncts, not only the barrier half. An `"unknown"`
     * entry never satisfies the first, so it proves nothing.
     * @type {Set<string>} */
    const effectiveInputs = new Set();
    for (const inputKeyString of currentInputs) {
        const claimed = basisValueOf(best.candidate, inputKeyString);
        if (claimed === undefined || claimed === "unknown") {
            continue;
        }
        const inputValueId = valueIdOf(records, inputKeyString);
        if (inputValueId === undefined) {
            continue;
        }
        if (journalRecordIdToString(claimed) !== journalRecordIdToString(inputValueId)) {
            continue;
        }
        if (uncoveredProofBarrier(records, nodeKeyString, inputKeyString, best.candidate)) {
            continue;
        }
        effectiveInputs.add(inputKeyString);
    }
    return {
        certificate: best.candidate,
        effectiveInputs,
        coversValue: best.score.coversValue,
    };
}

/**
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @returns {boolean}
 */
function isPresentIn(records, nodeKeyString) {
    const head = headCandidateOf(records, nodeKeyString);
    return head !== undefined && isValueEvent(head);
}

/**
 * `edgeValid(D,K)`.
 * @param {JournalRecord[]} records
 * @param {string} inputKeyString
 * @param {string} nodeKeyString
 * @param {ReadonlyArray<string>} currentInputs
 * @returns {boolean}
 */
function edgeValidIn(records, inputKeyString, nodeKeyString, currentInputs) {
    if (!isPresentIn(records, inputKeyString) || !isPresentIn(records, nodeKeyString)) {
        return false;
    }
    const selected = selectedCertificateOf(records, nodeKeyString, currentInputs);
    if (selected === undefined) {
        return false;
    }
    return selected.effectiveInputs.has(inputKeyString);
}

/**
 * `fresh(K)`, resolved literally and recursively over the current schema.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {boolean}
 */
function freshIn(records, nodeKeyString, currentInputKeysOfNode) {
    return freshInWithVisited(records, nodeKeyString, currentInputKeysOfNode, new Set());
}

/**
 * `fresh(K)`, resolving the recursion with an explicit visited set.
 *
 * A cyclic current schema has no defined recursive freshness, and a schema the
 * two models are handed differently can be cyclic, so the model reports the cycle
 * rather than recursing forever. The oracle reports the same condition as a
 * projection failure.
 * @param {JournalRecord[]} records
 * @param {string} nodeKeyString
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @param {Set<string>} visiting
 * @returns {boolean}
 */
function freshInWithVisited(records, nodeKeyString, currentInputKeysOfNode, visiting) {
    if (visiting.has(nodeKeyString)) {
        return false;
    }
    if (!isPresentIn(records, nodeKeyString)) {
        return false;
    }
    const currentInputs = currentInputKeysOfNode(nodeKeyString);
    const selected = selectedCertificateOf(records, nodeKeyString, currentInputs);
    if (selected === undefined) {
        return false;
    }
    if (selected.effectiveInputs.size !== currentInputs.length) {
        return false;
    }
    if (!selected.coversValue) {
        return false;
    }
    visiting.add(nodeKeyString);
    for (const inputKeyString of currentInputs) {
        if (!isPresentIn(records, inputKeyString)) {
            visiting.delete(nodeKeyString);
            return false;
        }
        if (!freshInWithVisited(records, inputKeyString, currentInputKeysOfNode, visiting)) {
            visiting.delete(nodeKeyString);
            return false;
        }
    }
    visiting.delete(nodeKeyString);
    return true;
}

/**
 * The local writer's allocator watermark, read as the specification's maximum
 * over its own writer-state records.
 * @param {JournalRecord[]} records
 * @param {string} localWriterName
 * @returns {number}
 */
function lastNodeIndexOf(records, localWriterName) {
    let watermark = 0;
    for (const record of records) {
        if (!isWriterStateRecord(record)) {
            continue;
        }
        if (journalRecordIdToString(record.id).split(":")[0] !== localWriterName) {
            continue;
        }
        if (record.lastNodeIndex > watermark) {
            watermark = record.lastNodeIndex;
        }
    }
    return watermark;
}

/**
 * Is the selected head set dependency-closed under the current schema?
 *
 * `incremental-graph-journal-replay.md` §Dependency closure states that every
 * supported committed projection satisfies "present K implies every current input
 * of K is present", and that a union which violates it is not publishable. The
 * oracle therefore rejects such a journal, so the differential has to be able to
 * reject it too: agreement between the two models is only meaningful on
 * acceptance as well as on the projected result.
 * @param {JournalRecord[]} records
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {string[]}
 */
function nodesMissingInputs(records, currentInputKeysOfNode) {
    const nodeKeyStrings = [
        ...new Set(
            records
                .filter((record) => "node" in record)
                .map((record) => nodeKeyToCanonicalString(record.node))
        ),
    ].sort();
    /** @type {string[]} */
    const unclosed = [];
    for (const nodeKeyString of nodeKeyStrings) {
        if (!isPresentIn(records, nodeKeyString)) {
            continue;
        }
        for (const inputKeyString of currentInputKeysOfNode(nodeKeyString)) {
            if (!isPresentIn(records, inputKeyString)) {
                unclosed.push(nodeKeyString + " is present but its input " + inputKeyString + " is absent");
                break;
            }
        }
    }
    return unclosed;
}

/**
 * Project the journal the naive way, into the same comparable shape the oracle
 * returns.
 *
 * The result reports whether this model publishes the journal at all, so a
 * disagreement can be an acceptance disagreement and not only a projection one.
 * @param {import("../src/generators/incremental_graph/journal").JournalReplica} replica
 * @param {string} localWriterName
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {{publishable: boolean, rejections: string[], occurrences: Array<object>, lastNodeIndex: number}}
 */
function declarativeProject(replica, localWriterName, currentInputKeysOfNode) {
    const records = allRecordsOf(replica);
    const rejections = nodesMissingInputs(records, currentInputKeysOfNode);
    const nodeKeyStrings = [
        ...new Set(
            records
                .filter((record) => "node" in record)
                .map((record) => nodeKeyToCanonicalString(record.node))
        ),
    ].sort();
    const projected = [];
    for (const nodeKeyString of nodeKeyStrings) {
        if (!isPresentIn(records, nodeKeyString)) {
            continue;
        }
        const head = headCandidateOf(records, nodeKeyString);
        if (head === undefined || !isValueEvent(head)) {
            continue;
        }
        const currentInputs = currentInputKeysOfNode(nodeKeyString);
        projected.push({
            nodeKeyString,
            valueId: journalRecordIdToString(head.id),
            nodeIdentifier: head.nodeIdentifier,
            payload: head.payload,
            createdAt: head.createdAt,
            modifiedAt: head.modifiedAt,
            fresh: freshIn(records, nodeKeyString, currentInputKeysOfNode),
            validInputs: currentInputs
                .filter((inputKeyString) =>
                    edgeValidIn(records, inputKeyString, nodeKeyString, currentInputs)
                )
                .sort(),
        });
    }
    return {
        publishable: rejections.length === 0,
        rejections,
        occurrences: projected,
        lastNodeIndex: lastNodeIndexOf(records, localWriterName),
    };
}

module.exports = {
    allRecordsOf,
    declarativeProject,
    nodesMissingInputs,
    edgeValidIn,
    freshIn,
    headCandidateOf,
    historyOf,
    isPresentIn,
    lastNodeIndexOf,
    selectedCertificateOf,
    validationsOf,
    valueIdOf,
};
