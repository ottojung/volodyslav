const { makeUnchanged } = require("../../incremental_graph");

/**
 * @typedef {import('../../incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry
 */

/**
 * @typedef {object} DiarySummaryBox
 * @property {DiaryMostImportantInfoSummaryEntry | 'never-set'} value
 */

/**
 * @returns {DiarySummaryBox}
 */
function makeBox() {
    return { value: "never-set" };
}

/**
 * Default empty summary value returned when the node has never been set.
 * @returns {DiaryMostImportantInfoSummaryEntry}
 */
function makeDefaultSummary() {
    return {
        type: "diary_most_important_info_summary",
        markdown: [
            "## Current snapshot",
            "",
            "- No entries yet.",
            "",
            "## Ongoing themes and patterns",
            "",
            "- None recorded.",
            "",
            "## Important people and relationships",
            "",
            "- None recorded.",
            "",
            "## Projects / work / obligations",
            "",
            "- None recorded.",
            "",
            "## Health / symptoms / body / habits",
            "",
            "- None recorded.",
            "",
            "## Decisions / commitments / open loops",
            "",
            "- None recorded.",
            "",
            "## Recent important changes",
            "",
            "- None recorded.",
            "",
            "## Wins / progress / helpful things",
            "",
            "- None recorded.",
        ].join("\n"),
        summaryDate: "",
        processedTranscriptions: {},
        updatedAt: "",
        model: "",
        version: "1",
    };
}

/**
 * @param {DiarySummaryBox} box
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(box) {
    return async (_inputs, oldValue, _bindings) => {
        if (box.value === "never-set") {
            if (oldValue === undefined) {
                return makeDefaultSummary();
            } else {
                return makeUnchanged();
            }
        }

        const nextValue = box.value;
        if (
            oldValue !== undefined &&
            oldValue.type === "diary_most_important_info_summary" &&
            JSON.stringify(oldValue) === JSON.stringify(nextValue)
        ) {
            return makeUnchanged();
        }
        return nextValue;
    };
}

module.exports = {
    makeBox,
    makeComputor,
    makeDefaultSummary,
};
