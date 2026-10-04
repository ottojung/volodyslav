/**
 * The reset subfolder's encapsulation point.
 *
 * This module is the only import point of `journal_reset`. A caller outside this
 * subfolder reaches reset through `resetToSource`, the reset source it targets and
 * the small set of guards and types which describe the outcome. The passes stay
 * private, so a caller cannot import Pass 1 without the ordering the specification
 * gives it, and cannot observe a cut between two passes.
 *
 * `resetToSource` performs everything up to but excluding the publication write: it
 * admits the missing source history, inspects the raw union through its selected
 * heads, allocates the receiver-authored records the three passes require, and
 * returns `project(Jreset)` together with the records to retain. Nothing here
 * touches storage, so the whole algorithm is exercised against a supported graph
 * plus Journal pair.
 */

/** @typedef {import('./source').ResetSource} ResetSource */
/** @typedef {import('./authoring').ResetPublication} ResetPublication */
/** @typedef {import('./pass1').ResetValueId} ResetValueId */
/** @typedef {import('./reset').ResetOutcome} ResetOutcome */
/** @typedef {import('./reset').ResetRequestBody} ResetRequestBody */
/** @typedef {import('./authoring').ResetRequest} ResetRequest */
/** @typedef {import('./pass1').ResetDomain} ResetDomain */
/** @typedef {import('./pass2').ProofBarriers} ProofBarriers */
/** @typedef {import('./pass2').TargetValidations} TargetValidations */
/** @typedef {import('./pass3').FreshnessMarkers} FreshnessMarkers */

const { ResetSourceClass, isResetSource, makeResetSource } = require("./source");
const { ResetPublicationClass, isResetPublication } = require("./authoring");
const { ResetDomainClass, isResetDomain } = require("./pass1");
const { ProofBarriersClass, TargetValidationsClass } = require("./pass2");
const { FreshnessMarkersClass } = require("./pass3");
const { ResetOutcomeClass, isResetOutcome, resetToSource } = require("./reset");

module.exports = {
    FreshnessMarkersClass,
    ProofBarriersClass,
    ResetDomainClass,
    ResetOutcomeClass,
    ResetPublicationClass,
    ResetSourceClass,
    TargetValidationsClass,
    isResetDomain,
    isResetOutcome,
    isResetPublication,
    isResetSource,
    makeResetSource,
    resetToSource,
};